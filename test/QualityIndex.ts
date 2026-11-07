import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("QualityIndex", function () {
  async function deploy() {
    const [admin, supplyChain, beekeeper, lab, certBody, awardBody, outsider] = await ethers.getSigners();

    const registry = await ethers.deployContract("ActorRegistry", [], admin);
    await registry.connect(admin).grantRole(await registry.BEEKEEPER_ROLE(), beekeeper.address);
    await registry.connect(admin).grantRole(await registry.LAB_ROLE(), lab.address);
    await registry.connect(admin).grantRole(await registry.CERTIFICATION_BODY_ROLE(), certBody.address);
    await registry.connect(admin).grantRole(await registry.AWARD_BODY_ROLE(), awardBody.address);

    const qualityIndex = await ethers.deployContract("QualityIndex", [await registry.getAddress()], admin);
    await qualityIndex.connect(admin).setSupplyChain(supplyChain.address);

    return { registry, qualityIndex, admin, supplyChain, beekeeper, lab, certBody, awardBody, outsider };
  }

  const emptySI = {
    forage: 0, lightIntensity: 0, waterSource: 0, summerTemperature: 0,
    winterTemperature: 0, windSpeed: 0, humidity: 0, precipitation: 0,
  };
  const emptyPHQI = { normalizedWaterContent: 0, hmf: 0, invertaseActivity: 0, waterContentPercent: 0 };

  it("allows the admin to set SupplyChain", async function () {
    const { qualityIndex, supplyChain } = await deploy();
    expect(await qualityIndex.supplyChain()).to.equal(supplyChain.address);
  });

  it("rejects setSupplyChain from a non-admin", async function () {
    const { qualityIndex, outsider, supplyChain } = await deploy();
    await expect(qualityIndex.connect(outsider).setSupplyChain(supplyChain.address)).to.revert(ethers);
  });

  it("weights SI criteria correctly", async function () {
    const { qualityIndex, beekeeper } = await deploy();
    await qualityIndex.connect(beekeeper).submitSIData(1, { ...emptySI, forage: 10000 });

    const data = await qualityIndex.getQualityData(1);
    expect(data.si).to.equal(3741);
  });

  it("rejects submitSIData from a non-beekeeper", async function () {
    const { qualityIndex, outsider } = await deploy();
    await expect(qualityIndex.connect(outsider).submitSIData(1, emptySI)).to.revert(ethers);
  });

  it("averages PHQI criteria equally, reaching exactly 10000 at three maximum values", async function () {
    const { qualityIndex, lab } = await deploy();
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.phqi).to.equal(10000);
    expect(data.state).to.equal(0);
  });

  it("zeroes PHQI when the water content criterion hits the worst Saaty tier, without triggering the hard gatekeeper", async function () {
    const { qualityIndex, lab } = await deploy();
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 0, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 2100,
    }, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.phqi).to.equal(0);
    expect(data.reason).to.equal(0);
    expect(data.state).to.equal(0);
  });

  it("zeroes PHQI when the HMF criterion hits the worst Saaty tier", async function () {
    const { qualityIndex, lab } = await deploy();
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 0, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.phqi).to.equal(0);
  });

  it("zeroes PHQI when the invertase activity criterion hits the worst Saaty tier", async function () {
    const { qualityIndex, lab } = await deploy();
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 0, waterContentPercent: 1500,
    }, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.phqi).to.equal(0);
  });


  it("triggers the hard gatekeeper and marks the batch not sellable above 23% water content", async function () {
    const { qualityIndex, lab } = await deploy();
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 2400,
    }, 0, "");

    const [sellable, reason] = await qualityIndex.checkGatekeeper(1);
    expect(sellable).to.equal(false);
    expect(reason).to.equal(1);
  });

  it("rejects submitPHQIData from a non-lab caller", async function () {
    const { qualityIndex, outsider } = await deploy();
    await expect(qualityIndex.connect(outsider).submitPHQIData(1, emptyPHQI, 0, "")).to.revert(ethers);
  });

  it("combines MCI data from the beekeeper and the award body, including the organic score from ActorRegistry", async function () {
    const { registry, qualityIndex, beekeeper, certBody, awardBody, lab } = await deploy();

    await registry.connect(certBody).setCertification(beekeeper.address, "bafybeicert", 10000);
    await qualityIndex.connect(lab).submitPHQIData(1, emptyPHQI, 10000, "bafybeilab");
    await qualityIndex.connect(beekeeper).submitOrigin(1, 0, "");
    await qualityIndex.connect(awardBody).submitAward(1, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.mci).to.equal(1924 + 1618);
  });

  it("caps MCI at exactly 10000 when variety, region, organic, and award are all maxed", async function () {
    const { registry, qualityIndex, beekeeper, certBody, awardBody, lab } = await deploy();

    await registry.connect(certBody).setCertification(beekeeper.address, "bafybeicert", 10000);
    await qualityIndex.connect(lab).submitPHQIData(1, emptyPHQI, 10000, "bafybeilab");
    await qualityIndex.connect(beekeeper).submitOrigin(1, 10000, "");
    await qualityIndex.connect(awardBody).submitAward(1, 10000, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.mci).to.equal(10000);
  });

  it("rejects submitOrigin from a non-beekeeper", async function () {
    const { qualityIndex, outsider } = await deploy();
    await expect(qualityIndex.connect(outsider).submitOrigin(1, 0, "")).to.revert(ethers);
  });

  it("rejects submitAward from a caller without AWARD_BODY_ROLE", async function () {
    const { qualityIndex, outsider } = await deploy();
    await expect(qualityIndex.connect(outsider).submitAward(1, 0, "")).to.revert(ethers);
  });

  it("combines SI, PHQI, and MCI into QI using the published weights", async function () {
    const { qualityIndex, beekeeper, lab, awardBody } = await deploy();

    await qualityIndex.connect(beekeeper).submitSIData(1, { ...emptySI, forage: 10000 });
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 10000, "");
    await qualityIndex.connect(beekeeper).submitOrigin(1, 0, "");
    await qualityIndex.connect(awardBody).submitAward(1, 0, "");

    const data = await qualityIndex.getQualityData(1);
    expect(data.si).to.equal(3741);
    expect(data.phqi).to.equal(10000);
    expect(data.mci).to.equal(1924);
    expect(data.qi).to.equal(6574);
  });

  it("sums the QI weights (PHQI/MCI/SI) to exactly 10000", async function () {
    const { registry, qualityIndex, beekeeper, certBody, awardBody, lab } = await deploy();

    await registry.connect(certBody).setCertification(beekeeper.address, "bafybeicert", 10000);
    await qualityIndex.connect(lab).submitPHQIData(1, { normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500 }, 10000, "");
    await qualityIndex.connect(beekeeper).submitOrigin(1, 10000, "");
    await qualityIndex.connect(awardBody).submitAward(1, 10000, "");
    await qualityIndex.connect(beekeeper).submitSIData(1, {
      forage: 10000, lightIntensity: 10000, waterSource: 10000, summerTemperature: 10000,
      winterTemperature: 10000, windSpeed: 10000, humidity: 10000, precipitation: 10000,
    });

    const data = await qualityIndex.getQualityData(1);
    expect(data.phqi).to.equal(10000);
    expect(data.mci).to.equal(10000);
    expect(data.si).to.equal(9999);
    expect(data.qi).to.equal(9999);
  });

  it("requires a retest on a temperature violation without downgrading a not-sellable batch", async function () {
    const { qualityIndex, supplyChain, lab } = await deploy();

    await qualityIndex.connect(lab).submitPHQIData(1, { ...emptyPHQI, waterContentPercent: 2400 }, 0, "");
    await qualityIndex.connect(supplyChain).triggerTemperatureViolation(1);

    const [, reason] = await qualityIndex.checkGatekeeper(1);
    expect(reason).to.equal(1);
  });

  it("clears a retest requirement once PHQI is resubmitted", async function () {
    const { qualityIndex, supplyChain, lab } = await deploy();

    await qualityIndex.connect(supplyChain).triggerTemperatureViolation(1);
    let data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(1);

    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 0, "");

    data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(0);
  });

  it("rejects triggerTemperatureViolation from a caller that is not SupplyChain", async function () {
    const { qualityIndex, outsider } = await deploy();
    await expect(qualityIndex.connect(outsider).triggerTemperatureViolation(1)).to.revert(ethers);
  });
});

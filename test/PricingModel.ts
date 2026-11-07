import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("PricingModel", function () {
  const INITIAL_ALPHA = 8000;

  async function deploy() {
    const [admin, beekeeper, lab, awardBody, outsider] = await ethers.getSigners();

    const registry = await ethers.deployContract("ActorRegistry", [], admin);
    await registry.connect(admin).grantRole(await registry.BEEKEEPER_ROLE(), beekeeper.address);
    await registry.connect(admin).grantRole(await registry.LAB_ROLE(), lab.address);
    await registry.connect(admin).grantRole(await registry.AWARD_BODY_ROLE(), awardBody.address);

    const qualityIndex = await ethers.deployContract("QualityIndex", [await registry.getAddress()], admin);

    const pricingModel = await ethers.deployContract(
      "PricingModel",
      [await registry.getAddress(), await qualityIndex.getAddress(), INITIAL_ALPHA],
      admin,
    );

    return { registry, qualityIndex, pricingModel, admin, beekeeper, lab, awardBody, outsider };
  }

  async function submitGoodQualityBatch(qualityIndex: any, beekeeper: any, lab: any, awardBody: any, batchId: number) {
    await qualityIndex.connect(beekeeper).submitSIData(batchId, {
      forage: 10000, lightIntensity: 0, waterSource: 0, summerTemperature: 0,
      winterTemperature: 0, windSpeed: 0, humidity: 0, precipitation: 0,
    });
    await qualityIndex.connect(lab).submitPHQIData(batchId, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 10000, "");
    await qualityIndex.connect(beekeeper).submitOrigin(batchId, 0, "");
    await qualityIndex.connect(awardBody).submitAward(batchId, 0, "");
  }

  it("sets the constructor parameters", async function () {
    const { pricingModel, registry, qualityIndex } = await deploy();
    expect(await pricingModel.alpha()).to.equal(INITIAL_ALPHA);
    expect(await pricingModel.actorRegistry()).to.equal(await registry.getAddress());
    expect(await pricingModel.qualityIndex()).to.equal(await qualityIndex.getAddress());
  });

  it("allows the admin to set alpha", async function () {
    const { pricingModel, admin } = await deploy();
    await pricingModel.connect(admin).setAlpha(9000);
    expect(await pricingModel.alpha()).to.equal(9000);
  });

  it("rejects setAlpha from a non-admin", async function () {
    const { pricingModel, outsider } = await deploy();
    await expect(pricingModel.connect(outsider).setAlpha(9000)).to.revert(ethers);
  });

  it("allows the admin to set a floor price for a valid jar size", async function () {
    const { pricingModel, admin } = await deploy();
    await pricingModel.connect(admin).setFloorPrice(500, 480);
    expect(await pricingModel.floorPrices(500)).to.equal(480);
  });

  it("rejects setFloorPrice for an unsupported jar size", async function () {
    const { pricingModel, admin } = await deploy();
    await expect(pricingModel.connect(admin).setFloorPrice(333, 480)).to.revert(ethers);
  });

  it("rejects setFloorPrice from a non-admin", async function () {
    const { pricingModel, outsider } = await deploy();
    await expect(pricingModel.connect(outsider).setFloorPrice(500, 480)).to.revert(ethers);
  });

  it("computes the price from the floor, alpha, and QI", async function () {
    const { pricingModel, qualityIndex, admin, beekeeper, lab, awardBody } = await deploy();
    await pricingModel.connect(admin).setFloorPrice(500, 480);
    await submitGoodQualityBatch(qualityIndex, beekeeper, lab, awardBody, 1);

    expect(await pricingModel.calculatePrice(1, 500)).to.equal(732);
  });

  it("getPrice returns the same value as calculatePrice", async function () {
    const { pricingModel, qualityIndex, admin, beekeeper, lab, awardBody } = await deploy();
    await pricingModel.connect(admin).setFloorPrice(500, 480);
    await submitGoodQualityBatch(qualityIndex, beekeeper, lab, awardBody, 1);

    expect(await pricingModel.getPrice(1, 500)).to.equal(await pricingModel.calculatePrice(1, 500));
  });

  it("reverts when the batch is not sellable", async function () {
    const { pricingModel, qualityIndex, admin, lab } = await deploy();
    await pricingModel.connect(admin).setFloorPrice(500, 480);
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 0, hmf: 0, invertaseActivity: 0, waterContentPercent: 2400,
    }, 0, "");

    await expect(pricingModel.calculatePrice(1, 500)).to.revert(ethers);
  });

  it("reverts when no floor price is set for the requested jar size", async function () {
    const { pricingModel, qualityIndex, beekeeper, lab, awardBody } = await deploy();
    await submitGoodQualityBatch(qualityIndex, beekeeper, lab, awardBody, 1);

    await expect(pricingModel.calculatePrice(1, 500)).to.revert(ethers);
  });
});

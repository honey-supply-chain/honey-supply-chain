import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("ProductGateway", function () {
  async function deploy() {
    const [admin, beekeeper, lab, awardBody, outsider] = await ethers.getSigners();

    const registry = await ethers.deployContract("ActorRegistry", [], admin);
    await registry.connect(admin).grantRole(await registry.BEEKEEPER_ROLE(), beekeeper.address);
    await registry.connect(admin).grantRole(await registry.LAB_ROLE(), lab.address);
    await registry.connect(admin).grantRole(await registry.AWARD_BODY_ROLE(), awardBody.address);

    const honeyToken = await ethers.deployContract("HoneyToken", [""], admin);
    const qualityIndex = await ethers.deployContract("QualityIndex", [await registry.getAddress()], admin);
    const pricingModel = await ethers.deployContract(
      "PricingModel",
      [await registry.getAddress(), await qualityIndex.getAddress(), 8000],
      admin,
    );
    const supplyChain = await ethers.deployContract(
      "SupplyChain",
      [await registry.getAddress(), await honeyToken.getAddress(), await qualityIndex.getAddress()],
      admin,
    );
    await honeyToken.connect(admin).setSupplyChain(await supplyChain.getAddress());
    await qualityIndex.connect(admin).setSupplyChain(await supplyChain.getAddress());

    const gateway = await ethers.deployContract(
      "ProductGateway",
      [
        await registry.getAddress(),
        await supplyChain.getAddress(),
        await honeyToken.getAddress(),
        await qualityIndex.getAddress(),
        await pricingModel.getAddress(),
      ],
      admin,
    );

    return { registry, honeyToken, qualityIndex, pricingModel, supplyChain, gateway, admin, beekeeper, lab, awardBody, outsider };
  }

  it("sets all constructor references", async function () {
    const { gateway, registry, supplyChain, honeyToken, qualityIndex, pricingModel } = await deploy();
    expect(await gateway.actorRegistry()).to.equal(await registry.getAddress());
    expect(await gateway.supplyChain()).to.equal(await supplyChain.getAddress());
    expect(await gateway.honeyToken()).to.equal(await honeyToken.getAddress());
    expect(await gateway.qualityIndex()).to.equal(await qualityIndex.getAddress());
    expect(await gateway.pricingModel()).to.equal(await pricingModel.getAddress());
  });

  it("allows the admin to update each reference", async function () {
    const { gateway, admin, outsider } = await deploy();
    await gateway.connect(admin).setSupplyChain(outsider.address);
    await gateway.connect(admin).setHoneyToken(outsider.address);
    await gateway.connect(admin).setQualityIndex(outsider.address);
    await gateway.connect(admin).setPricingModel(outsider.address);

    expect(await gateway.supplyChain()).to.equal(outsider.address);
    expect(await gateway.honeyToken()).to.equal(outsider.address);
    expect(await gateway.qualityIndex()).to.equal(outsider.address);
    expect(await gateway.pricingModel()).to.equal(outsider.address);
  });

  it("rejects reference updates from a non-admin", async function () {
    const { gateway, outsider } = await deploy();
    await expect(gateway.connect(outsider).setSupplyChain(outsider.address)).to.revert(ethers);
    await expect(gateway.connect(outsider).setHoneyToken(outsider.address)).to.revert(ethers);
    await expect(gateway.connect(outsider).setQualityIndex(outsider.address)).to.revert(ethers);
    await expect(gateway.connect(outsider).setPricingModel(outsider.address)).to.revert(ethers);
  });

  it("forwards getBatchData to SupplyChain.getBatch", async function () {
    const { gateway, supplyChain, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);

    const fromGateway = await gateway.getBatchData(1);
    const fromSupplyChain = await supplyChain.getBatch(1);

    expect(fromGateway.batch.quantity).to.equal(fromSupplyChain.batch.quantity);
    expect(fromGateway.batch.beekeeper).to.equal(fromSupplyChain.batch.beekeeper);
    expect(fromGateway.holder).to.equal(fromSupplyChain.holder);
  });

  it("forwards getTokenData to HoneyToken.getTokenData", async function () {
    const { gateway, honeyToken, supplyChain, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);

    const fromGateway = await gateway.getTokenData(1);
    const fromHoneyToken = await honeyToken.getTokenData(1);

    expect(fromGateway.batchId).to.equal(fromHoneyToken.batchId);
    expect(fromGateway.originalQuantity).to.equal(fromHoneyToken.originalQuantity);
  });

  it("forwards getQualityData to QualityIndex.getQualityData", async function () {
    const { gateway, qualityIndex, beekeeper } = await deploy();
    await qualityIndex.connect(beekeeper).submitSIData(1, {
      forage: 10000, lightIntensity: 0, waterSource: 0, summerTemperature: 0,
      winterTemperature: 0, windSpeed: 0, humidity: 0, precipitation: 0,
    });

    const fromGateway = await gateway.getQualityData(1);
    const fromQualityIndex = await qualityIndex.getQualityData(1);

    expect(fromGateway.si).to.equal(fromQualityIndex.si);
    expect(fromGateway.qi).to.equal(fromQualityIndex.qi);
  });

  it("forwards getPrice to PricingModel.getPrice", async function () {
    const { gateway, pricingModel, qualityIndex, beekeeper, lab, awardBody, admin } = await deploy();
    await pricingModel.connect(admin).setFloorPrice(500, 480);
    await qualityIndex.connect(beekeeper).submitSIData(1, {
      forage: 10000, lightIntensity: 0, waterSource: 0, summerTemperature: 0,
      winterTemperature: 0, windSpeed: 0, humidity: 0, precipitation: 0,
    });
    await qualityIndex.connect(lab).submitPHQIData(1, {
      normalizedWaterContent: 10000, hmf: 10000, invertaseActivity: 10000, waterContentPercent: 1500,
    }, 10000, "");
    await qualityIndex.connect(beekeeper).submitOrigin(1, 0, "");
    await qualityIndex.connect(awardBody).submitAward(1, 0, "");

    const fromGateway = await gateway.getPrice(1, 500);
    const fromPricingModel = await pricingModel.getPrice(1, 500);

    expect(fromGateway).to.equal(fromPricingModel);
    expect(fromGateway).to.equal(732); // bekannter Wert aus dem PricingModel-Test
  });
});

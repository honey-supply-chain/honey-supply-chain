import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("SupplyChain", function () {
  async function deploy() {
    const [admin, beekeeper, bottler, logistics, retailer, outsider, lab] = await ethers.getSigners();

    const registry = await ethers.deployContract("ActorRegistry", [], admin);
    await registry.connect(admin).grantRole(await registry.BEEKEEPER_ROLE(), beekeeper.address);
    await registry.connect(admin).grantRole(await registry.BOTTLER_ROLE(), bottler.address);
    await registry.connect(admin).grantRole(await registry.LOGISTICS_ROLE(), logistics.address);
    await registry.connect(admin).grantRole(await registry.RETAILER_ROLE(), retailer.address);
    await registry.connect(admin).grantRole(await registry.LAB_ROLE(), lab.address);

    const honeyToken = await ethers.deployContract("HoneyToken", [""], admin);
    const qualityIndex = await ethers.deployContract("QualityIndex", [await registry.getAddress()], admin);

    const supplyChain = await ethers.deployContract(
      "SupplyChain",
      [await registry.getAddress(), await honeyToken.getAddress(), await qualityIndex.getAddress()],
      admin,
    );

    await honeyToken.connect(admin).setSupplyChain(await supplyChain.getAddress());
    await qualityIndex.connect(admin).setSupplyChain(await supplyChain.getAddress());

    return { registry, honeyToken, qualityIndex, supplyChain, admin, beekeeper, bottler, logistics, retailer, outsider, lab };
  }

  const emptyPHQI = { normalizedWaterContent: 0, hmf: 0, invertaseActivity: 0, waterContentPercent: 0 };

  it("registers a harvest batch, mints the bulk token, and sets the beekeeper as current holder", async function () {
    const { supplyChain, honeyToken, beekeeper } = await deploy();

    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1, 2], [600, 400]);

    const [batch, holder] = await supplyChain.getBatch(1);
    expect(batch.quantity).to.equal(1000);
    expect(batch.harvestYear).to.equal(2026);
    expect(batch.beekeeper).to.equal(beekeeper.address);
    expect(holder).to.equal(beekeeper.address);
    expect(await honeyToken.balanceOf(beekeeper.address, 1)).to.equal(1000);
  });

  it("rejects registerHarvestBatch from a non-beekeeper", async function () {
    const { supplyChain, outsider } = await deploy();
    await expect(supplyChain.connect(outsider).registerHarvestBatch(2026, [1], [1000])).to.revert(ethers);
  });

  it("rejects registerHarvestBatch when the location arrays have different lengths", async function () {
    const { supplyChain, beekeeper } = await deploy();
    await expect(
      supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1, 2], [1000]),
    ).to.revert(ethers);
  });

  it("stores the per-location contributions", async function () {
    const { supplyChain, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1, 2], [600, 400]);

    const first = await supplyChain.batchLocations(1, 0);
    const second = await supplyChain.batchLocations(1, 1);
    expect(first.standId).to.equal(1);
    expect(first.quantity).to.equal(600);
    expect(second.standId).to.equal(2);
    expect(second.quantity).to.equal(400);
  });

  it("transfers custody, records history, and moves the bulk token", async function () {
    const { supplyChain, honeyToken, beekeeper, bottler } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await honeyToken.connect(beekeeper).setApprovalForAll(await supplyChain.getAddress(), true);

    await supplyChain.connect(beekeeper).transferCustody(1, bottler.address);

    expect(await supplyChain.currentHolder(1)).to.equal(bottler.address);
    expect(await honeyToken.balanceOf(beekeeper.address, 1)).to.equal(0);
    expect(await honeyToken.balanceOf(bottler.address, 1)).to.equal(1000);

    const record = await supplyChain.custodyHistory(1, 0);
    expect(record.from).to.equal(beekeeper.address);
    expect(record.to).to.equal(bottler.address);
  });

  it("rejects transferCustody from a caller that does not hold custody", async function () {
    const { supplyChain, beekeeper, outsider } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await expect(supplyChain.connect(outsider).transferCustody(1, outsider.address)).to.revert(ethers);
  });

  it("processes and bottles a batch, minting jars to the bottler", async function () {
    const { supplyChain, honeyToken, beekeeper, bottler } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await honeyToken.connect(beekeeper).setApprovalForAll(await supplyChain.getAddress(), true);
    await supplyChain.connect(beekeeper).transferCustody(1, bottler.address);

    await expect(supplyChain.connect(bottler).processAndBottle(1, [500, 250], [1, 2]))
      .to.emit(supplyChain, "BatchBottled")
      .withArgs(1);

    const jarId500 = await honeyToken.jarTokenId(1, 500);
    const jarId250 = await honeyToken.jarTokenId(1, 250);
    expect(await honeyToken.balanceOf(bottler.address, jarId500)).to.equal(1);
    expect(await honeyToken.balanceOf(bottler.address, jarId250)).to.equal(2);
    expect(await honeyToken.processedBatches(1)).to.equal(true);
  });

  it("rejects processAndBottle from a caller that is not the current holder", async function () {
    const { supplyChain, beekeeper, bottler } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await expect(supplyChain.connect(bottler).processAndBottle(1, [500], [2])).to.revert(ethers);
  });

  it("rejects processAndBottle from a caller without BOTTLER_ROLE", async function () {
    const { supplyChain, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await expect(supplyChain.connect(beekeeper).processAndBottle(1, [500], [2])).to.revert(ethers);
  });

  it("triggers a temperature violation when both thresholds are exceeded", async function () {
    const { supplyChain, qualityIndex, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);

    await supplyChain.connect(beekeeper).recordTransportData(1, 45, 90);

    const data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(1);
  });

  it("does not trigger a violation unless both temperature and duration exceed the thresholds", async function () {
    const { supplyChain, qualityIndex, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);

    await supplyChain.connect(beekeeper).recordWarehouseData(1, 45, 30);
    await supplyChain.connect(beekeeper).recordWarehouseData(1, 35, 90);

    const data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(0);
  });

  it("accepts a below-zero temperature without reverting or triggering a violation", async function () {
    const { supplyChain, qualityIndex, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);

    await supplyChain.connect(beekeeper).recordTransportData(1, -2, 90);

    const data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(0);
  });

  it("allows the admin to adjust the safety thresholds", async function () {
    const { supplyChain, admin } = await deploy();
    await supplyChain.connect(admin).setMaxSafeTemperature(50);
    await supplyChain.connect(admin).setMaxSafeDuration(120);

    expect(await supplyChain.maxSafeTemperatureCelsius()).to.equal(50);
    expect(await supplyChain.maxSafeDurationMinutes()).to.equal(120);
  });

  it("rejects setMaxSafeTemperature from a non-admin", async function () {
    const { supplyChain, outsider } = await deploy();
    await expect(supplyChain.connect(outsider).setMaxSafeTemperature(50)).to.revert(ethers);
  });

  it("still allows recordWarehouseData and recordTransportData while a retest is required", async function () {
    const { supplyChain, qualityIndex, beekeeper } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await supplyChain.connect(beekeeper).recordTransportData(1, 45, 90);

    let data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(1); // RetestRequired

    await supplyChain.connect(beekeeper).recordWarehouseData(1, 10, 10);
    await supplyChain.connect(beekeeper).recordTransportData(1, 10, 10);

    data = await qualityIndex.getQualityData(1);
    expect(data.state).to.equal(1); // unveraendert, kein Revert
  });

  it("blocks transferCustody while a retest is required", async function () {
    const { supplyChain, beekeeper, bottler } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await supplyChain.connect(beekeeper).recordTransportData(1, 45, 90);

    await expect(supplyChain.connect(beekeeper).transferCustody(1, bottler.address)).to.revert(ethers);
  });

  it("blocks transferCustody once the batch is not sellable", async function () {
    const { supplyChain, qualityIndex, beekeeper, bottler, lab } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await qualityIndex.connect(lab).submitPHQIData(1, { ...emptyPHQI, waterContentPercent: 2400 }, 0, "");

    await expect(supplyChain.connect(beekeeper).transferCustody(1, bottler.address)).to.revert(ethers);
  });

  it("blocks processAndBottle while a retest is required", async function () {
    const { supplyChain, honeyToken, beekeeper, bottler } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await honeyToken.connect(beekeeper).setApprovalForAll(await supplyChain.getAddress(), true);
    await supplyChain.connect(beekeeper).transferCustody(1, bottler.address);
    await supplyChain.connect(bottler).recordTransportData(1, 45, 90);

    await expect(supplyChain.connect(bottler).processAndBottle(1, [500], [2])).to.revert(ethers);
  });

  it("blocks processAndBottle once the batch is not sellable", async function () {
    const { supplyChain, honeyToken, qualityIndex, beekeeper, bottler, lab } = await deploy();
    await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000]);
    await honeyToken.connect(beekeeper).setApprovalForAll(await supplyChain.getAddress(), true);
    await supplyChain.connect(beekeeper).transferCustody(1, bottler.address);
    await qualityIndex.connect(lab).submitPHQIData(1, { ...emptyPHQI, waterContentPercent: 2400 }, 0, "");

    await expect(supplyChain.connect(bottler).processAndBottle(1, [500], [2])).to.revert(ethers);
  });
});

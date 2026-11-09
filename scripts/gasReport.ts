import { deployAndBootstrap } from "./lib/chainSetup.js";
import { cidToBytes32 } from "./lib/cid.js";

const CID_A = cidToBytes32("QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");
const CID_B = cidToBytes32("QmSnuWmxptJZdLJpKRarxBMS2Ju2oANVrgbr2xWbie9b2D");

const EMPTY_SI = { forage: 0, lightIntensity: 0, waterSource: 0, summerTemperature: 0, winterTemperature: 0, windSpeed: 0, humidity: 0, precipitation: 0 };
const GOOD_PHQI = { normalizedWaterContent: 9000, hmf: 9000, invertaseActivity: 9000, waterContentPercent: 1500 };

type Row = { step: string; gas: number };
const rows: Row[] = [];

async function measure(step: string, send: () => Promise<any>) {
  const tx = await send();
  const receipt = await tx.wait();
  rows.push({ step, gas: Number(receipt.gasUsed) });
}

const { ethers, signers, contracts } = await deployAndBootstrap("hardhatMainnet");
const { admin, lab, awardBody, certBody, beekeeper, bottler, retailer, logistics } = signers;
const { actorRegistry, qualityIndex, pricingModel, supplyChain } = contracts;

const [, , , , , , , , , freshActor] = await ethers.getSigners();

await measure("PricingModel.setFloorPrice", () => pricingModel.connect(admin).setFloorPrice(500, 480));
await measure("PricingModel.setAlpha", () => pricingModel.connect(admin).setAlpha(8000));

const beekeeperRole = await actorRegistry.BEEKEEPER_ROLE();
await measure("ActorRegistry.registerActor", () => actorRegistry.connect(admin).registerActor(freshActor.address, "Frischer Akteur"));
await measure("ActorRegistry.grantRole", () => actorRegistry.connect(admin).grantRole(beekeeperRole, freshActor.address));
await measure("ActorRegistry.setCertification (erstmalig)", () => actorRegistry.connect(certBody).setCertification(beekeeper.address, CID_A, 8000));
await measure("ActorRegistry.setCertification (erneuert, neue CID)", () => actorRegistry.connect(certBody).setCertification(beekeeper.address, CID_B, 10000));

let batchId = await supplyChain.nextBatchId();
await measure("SupplyChain.registerHarvestBatch (1 Bienenstand)", () =>
  supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [25000]));
await measure("QualityIndex.submitSIData", () => qualityIndex.connect(beekeeper).submitSIData(batchId, EMPTY_SI));
await measure("QualityIndex.submitOrigin", () => qualityIndex.connect(beekeeper).submitOrigin(batchId, 3, CID_A));
await measure("QualityIndex.submitPHQIData (erstmalig)", () =>
  qualityIndex.connect(lab).submitPHQIData(batchId, GOOD_PHQI, 8000, CID_A));
await measure("QualityIndex.submitAward", () => qualityIndex.connect(awardBody).submitAward(batchId, 10000, CID_A));
await measure("SupplyChain.transferCustody (Imker->Logistik)", () =>
  supplyChain.connect(beekeeper).transferCustody(batchId, logistics.address));
await measure("SupplyChain.recordTransportData", () =>
  supplyChain.connect(logistics).recordTransportData(batchId, 10, 30));
await measure("SupplyChain.transferCustody (Logistik->Abfueller)", () =>
  supplyChain.connect(logistics).transferCustody(batchId, bottler.address));
await measure("SupplyChain.recordWarehouseData", () =>
  supplyChain.connect(bottler).recordWarehouseData(batchId, 10, 30));
await measure("SupplyChain.processAndBottle", () =>
  supplyChain.connect(bottler).processAndBottle(batchId, [500], [50]));
await measure("SupplyChain.transferCustody (Abfueller->Logistik)", () =>
  supplyChain.connect(bottler).transferCustody(batchId, logistics.address));
await measure("SupplyChain.transferCustody (Logistik->Haendler)", () =>
  supplyChain.connect(logistics).transferCustody(batchId, retailer.address));

batchId = await supplyChain.nextBatchId();
await measure("SupplyChain.registerHarvestBatch (2 Bienenstaende)", () =>
  supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1, 3], [15000, 10000]));

await qualityIndex.connect(lab).submitPHQIData(batchId, GOOD_PHQI, 8000, CID_A);
await supplyChain.connect(beekeeper).recordTransportData(batchId, 45, 90); // triggers RetestRequired
await measure("QualityIndex.submitPHQIData (Retest/Nachpruefung)", () =>
  qualityIndex.connect(lab).submitPHQIData(batchId, GOOD_PHQI, 8000, CID_B));

rows.sort((a, b) => b.gas - a.gas);
console.log("\nGas-Report (absteigend sortiert):\n");
const widest = Math.max(...rows.map((r) => r.step.length));
for (const r of rows) {
  console.log(`  ${r.step.padEnd(widest)}  ${r.gas.toString().padStart(8)} gas`);
}

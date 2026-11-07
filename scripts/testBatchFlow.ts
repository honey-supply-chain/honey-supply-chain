import { network } from "hardhat";
import HoneySupplyChainModule from "../ignition/modules/HoneySupplyChain.js";

const { ethers, ignition } = await network.connect({ network: "localhost" });

async function main() {
  const [admin, beekeeper, lab, awardBody] = await ethers.getSigners();

  const deployed = await ignition.deploy(HoneySupplyChainModule);
  // ignition.deploy()'s return type has no contract-specific methods - re-attach by address to
  // recover the typing ethers.getContractAt() gets from artifacts/.../artifacts.d.ts.
  const [actorRegistry, qualityIndex, pricingModel, supplyChain] = await Promise.all([
    ethers.getContractAt("ActorRegistry", await deployed.actorRegistry.getAddress()),
    ethers.getContractAt("QualityIndex", await deployed.qualityIndex.getAddress()),
    ethers.getContractAt("PricingModel", await deployed.pricingModel.getAddress()),
    ethers.getContractAt("SupplyChain", await deployed.supplyChain.getAddress()),
  ]);

  console.log("ActorRegistry:", await actorRegistry.getAddress());
  console.log("SupplyChain:  ", await supplyChain.getAddress());
  console.log("QualityIndex: ", await qualityIndex.getAddress());
  console.log("PricingModel: ", await pricingModel.getAddress());

  console.log("\n1) Rollen vergeben...");
  await (await actorRegistry.connect(admin).grantRole(await actorRegistry.BEEKEEPER_ROLE(), beekeeper.address)).wait();
  await (await actorRegistry.connect(admin).grantRole(await actorRegistry.LAB_ROLE(), lab.address)).wait();
  await (await actorRegistry.connect(admin).grantRole(await actorRegistry.AWARD_BODY_ROLE(), awardBody.address)).wait();

  console.log("2) Ernte registrieren...");
  await (await supplyChain.connect(beekeeper).registerHarvestBatch(2026, [1], [1000])).wait();
  const batchId = 1n; // erste jemals registrierte Charge in dieser Deployment-Instanz

  console.log("3) SI-Daten einreichen (Standortdaten)...");
  await (
    await qualityIndex.connect(beekeeper).submitSIData(batchId, {
      forage: 9000,
      lightIntensity: 7000,
      waterSource: 8000,
      summerTemperature: 8000,
      winterTemperature: 6000,
      windSpeed: 5000,
      humidity: 7000,
      precipitation: 4000,
    })
  ).wait();

  console.log("4) PHQI-Daten und Laborbefund einreichen (inkl. Sorte)...");
  await (
    await qualityIndex.connect(lab).submitPHQIData(batchId, {
      normalizedWaterContent: 8000,
      hmf: 9000,
      invertaseActivity: 8500,
      waterContentPercent: 1650, // 16,50 % - unauffällig, kein Gatekeeper
    }, 5000, "bafybeiexamplecid")
  ).wait();

  console.log("5) MCI-Herkunftsdaten einreichen (Region + Herkunftsdokument)...");
  await (await qualityIndex.connect(beekeeper).submitOrigin(batchId, 9000, "bafybeiexampleorigin")).wait();

  console.log("6) Prämierungsurkunde einreichen...");
  await (await qualityIndex.connect(awardBody).submitAward(batchId, 5000, "bafybeiawardcid")).wait();

  console.log("\n--- Ergebnis ---");
  const data = await qualityIndex.getQualityData(batchId);
  console.log("SI:   ", data.si.toString());
  console.log("PHQI: ", data.phqi.toString());
  console.log("MCI:  ", data.mci.toString());
  console.log("QI:   ", data.qi.toString());

  const priceCents = await pricingModel.getPrice(batchId, 500);
  console.log("Preis (500g-Glas):", (Number(priceCents) / 100).toFixed(2), "EUR");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

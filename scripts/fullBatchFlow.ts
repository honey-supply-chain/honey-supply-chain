import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther } from "ethers";
import { deployAndBootstrap } from "./lib/chainSetup.js";
import { cidToBytes32 } from "./lib/cid.js";

const NETWORK = process.env.NETWORK ?? "localhost";
const SIMULATOR_URL = process.env.SIMULATOR_URL ?? "http://127.0.0.1:8081/api";
const REPETITIONS = Number(process.env.REPETITIONS ?? 3);
const GENERATED_RUNS = Number(process.env.GENERATED_RUNS ?? 0);
const SEED = Number(process.env.SEED ?? 42);
const SCENARIO_FILTERS = (process.env.SCENARIO_FILTER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LIST_SCENARIOS = process.env.LIST_SCENARIOS === "1";
const ETH_EUR = Number(process.env.ETH_EUR ?? 2500);
const GWEI_ASSUMPTIONS = [5, 20, 50];
const TX_TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS ?? 180_000);
const MIN_BALANCE_ETH = Number(process.env.MIN_BALANCE_ETH ?? 0.05);
const JAR_GRAMS = 500;
const FLOOR_PRICE_CENTS = 480;
const ALPHA = 8000;

const STATIONS: Record<number, { name: string; distance: number }> = {
  1: { name: "Bienenstand_1", distance: 120 },
  2: { name: "Bienenstand_2", distance: 350 },
  3: { name: "Bienenstand_3", distance: 620 },
  4: { name: "Bienenstand_4", distance: 180 },
  5: { name: "Bienenstand_5", distance: 280 },
  6: { name: "Bienenstand_6", distance: 150 },
};
const SI_KEYS = ["forage", "lightIntensity", "waterSource", "summerTemperature",
  "winterTemperature", "windSpeed", "humidity", "precipitation"] as const;
const STATES = ["Active", "RetestRequired", "NotSellable"];
const REASONS = ["None", "WaterContentExceeded", "TemperatureViolation"];
const REGIONS = ["EU_NON_EU_MIX", "EU_MIX", "NATIONAL", "REGIONAL_GPS_VERIFIED"];
const REGION_WEIGHTS = [0.1, 0.1, 0.3, 0.5];

type Chain = "FULL" | "DIRECT";

type Row = Record<string, string | number>;
type Stand = { standId: number; grams: number; distance: number };

type QualityProfileId = "S-I" | "S-II" | "S-III" | "S-IV";
type QualityProfile = {
  labForce: string;
  variety?: string;
  region: string;
  award?: string;
  certification?: string;
};

const PROFILES: Record<QualityProfileId, QualityProfile> = {
  "S-I": { labForce: "PREMIUM", variety: "PREMIUM_VARIETAL", region: "REGIONAL_GPS_VERIFIED", award: "GOLD", certification: "ASSOCIATION_ORGANIC" },
  "S-II": { labForce: "STANDARD", variety: "MIXED_BLOSSOM", region: "REGIONAL_GPS_VERIFIED" },
  "S-III": { labForce: "GATEKEEPER", variety: "MIXED_BLOSSOM", region: "EU_NON_EU_MIX" },
  "S-IV": { labForce: "PHQI_EXCLUDED", variety: "PREMIUM_VARIETAL", region: "REGIONAL_GPS_VERIFIED", award: "GOLD", certification: "ASSOCIATION_ORGANIC" },
};

type ScenarioId = "F-1" | "F-2" | "F-3" | "F-4" | "F-5" | "F-6" | "F-7";
const SCENARIOS: Record<ScenarioId, { profile: QualityProfileId; chain: Chain; stands: [number, number][]; defrostViolation?: boolean }> = {
  "F-1": { profile: "S-I", chain: "DIRECT", stands: [[1, 25000]] },
  "F-2": { profile: "S-II", chain: "FULL", stands: [[1, 25000]] },
  "F-3": { profile: "S-III", chain: "FULL", stands: [[1, 25000]] },
  "F-4": { profile: "S-IV", chain: "DIRECT", stands: [[1, 25000]] },
  "F-5": { profile: "S-II", chain: "DIRECT", stands: [[1, 25000]], defrostViolation: true },
  "F-6": { profile: "S-II", chain: "DIRECT", stands: [[1, 15000], [3, 10000]] },
  "F-7": { profile: "S-II", chain: "FULL", stands: [[1, 25000]] },
};
const STATION_VARIANTS: Partial<Record<ScenarioId, number[]>> = {
  "F-1": [1, 5, 3], "F-2": [1, 5, 3], "F-3": [1, 5, 3], "F-4": [1, 5, 3],
};

type ResolvedRun = {
  scenarioId: string;
  profileId: QualityProfileId | "";
  chain: Chain;
  stands: Stand[];
  repetition: number;
  defrostViolation?: boolean;
  generatedRegion?: string;
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rand: () => number, values: T[], weights: number[]): T {
  let roll = rand();
  for (let i = 0; i < values.length; i++) {
    if ((roll -= weights[i]) < 0) return values[i];
  }
  return values[values.length - 1];
}

const referenceStand = (id: number, grams: number): Stand => ({ standId: id, grams, distance: STATIONS[id].distance });

function standLabel(stands: Stand[]): string {
  return stands.map((s) => `BS-${s.standId}`).join("+");
}

function simKey(scenarioId: string, stands: Stand[]): string {
  if (!(scenarioId in STATION_VARIANTS)) return scenarioId;
  const stationId = stands[0].standId;
  return stationId === 1 ? scenarioId : `${scenarioId}/BS-${stationId}`;
}

function buildRuns(): ResolvedRun[] {
  const runs: ResolvedRun[] = [];
  for (const [id, def] of Object.entries(SCENARIOS) as [ScenarioId, typeof SCENARIOS[ScenarioId]][]) {
    const stationIds = STATION_VARIANTS[id];
    const variants: Stand[][] = stationIds
      ? stationIds.map((stationId) => [referenceStand(stationId, def.stands[0][1])])
      : [def.stands.map(([standId, grams]) => referenceStand(standId, grams))];
    for (const stands of variants) {
      for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
        runs.push({ scenarioId: id, profileId: def.profile, chain: def.chain, stands, repetition, defrostViolation: def.defrostViolation });
      }
    }
  }

  const rand = mulberry32(SEED);
  for (let i = 1; i <= GENERATED_RUNS; i++) {
    const stationId = 1 + Math.floor(rand() * 6);
    const grams = (10 + Math.floor(rand() * 41)) * 500;
    const region = pickWeighted(rand, REGIONS, REGION_WEIGHTS);
    const chain: Chain = rand() < 0.7 ? "FULL" : "DIRECT";
    runs.push({
      scenarioId: `GENERATED-${i}`, profileId: "", chain, repetition: 1,
      stands: [{ standId: stationId, grams, distance: 50 + Math.floor(rand() * 750) }],
      generatedRegion: region,
    });
  }

  const name = (r: ResolvedRun) => `${r.scenarioId}/${standLabel(r.stands)}/rep${r.repetition}`;
  return runs.filter((r) => SCENARIO_FILTERS.length === 0 || SCENARIO_FILTERS.some((f) => name(r).includes(f) || r.scenarioId.includes(f)));
}

const runs = buildRuns();
if (LIST_SCENARIOS) {
  console.log(`${runs.length} run(s) match SCENARIO_FILTER="${SCENARIO_FILTERS.join(",")}":\n`);
  runs.forEach((r, i) => console.log(`  ${i + 1}. ${r.scenarioId} ${standLabel(r.stands)} rep${r.repetition} (${r.chain})`));
  process.exit(0);
}

const SIM_REFERENCE_PATH = fileURLToPath(new URL("./simReference.json", import.meta.url));
const simReference: { scenarios: Record<string, { qi: number; priceCents: number | null }> } =
  JSON.parse(readFileSync(SIM_REFERENCE_PATH, "utf8"));

const { ethers, signers, contracts } = await deployAndBootstrap(NETWORK);
const { beekeeper, bottler, retailer, logistics, lab, awardBody, certBody } = signers;
const { qualityIndex, supplyChain, productGateway } = contracts;

const PAYING_SIGNERS: [string, typeof beekeeper][] = [
  ["beekeeper", beekeeper], ["bottler", bottler], ["retailer", retailer], ["logistics", logistics],
  ["lab", lab], ["awardBody", awardBody], ["certBody", certBody],
];

async function lowBalanceSigner(): Promise<string | null> {
  for (const [name, signer] of PAYING_SIGNERS) {
    const balance = await ethers.provider.getBalance(signer.address);
    if (balance < parseEther(String(MIN_BALANCE_ETH))) {
      return `${name} (${signer.address}): ${formatEther(balance)} ETH, below the ${MIN_BALANCE_ETH} ETH minimum`;
    }
  }
  return null;
}

async function post(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${SIMULATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

const sensorPath = (kind: string, force?: string) => `/sensors/${kind}${force ? `?force=${force}` : ""}`;

async function snapshot(batchId: bigint): Promise<Row> {
  const q = await productGateway.getQualityData(batchId);
  let priceCents: string | number = "not sellable";
  try {
    priceCents = Number(await productGateway.getPrice(batchId, JAR_GRAMS));
  } catch { /* NotSellable: getPrice reverts */ }
  const [si, phqi, mci] = [Number(q.si), Number(q.phqi), Number(q.mci)];
  const expectedQi = Math.floor((5390 * phqi + 2972 * mci + 1638 * si) / 10000);
  const expectedPrice = Math.floor((FLOOR_PRICE_CENTS * (1e8 + ALPHA * Number(q.qi))) / 1e8);
  return {
    si, phqi, mci, qi: Number(q.qi), state: STATES[Number(q.state)], reason: REASONS[Number(q.reason)], priceCents,
    expectedQi, qiDeviation: Number(q.qi) - expectedQi,
    expectedPriceCents: expectedPrice, priceDeviation: typeof priceCents === "number" ? priceCents - expectedPrice : ""
  };
}

async function runBatch(runNo: number, run: ResolvedRun, steps: Row[]): Promise<Row> {
  const { scenarioId, profileId, chain, stands, repetition, defrostViolation } = run;
  const profile = profileId ? PROFILES[profileId] : undefined;
  const runSteps: Row[] = [];
  let batchId = 0n;
  let bottled = false;
  const gasByActor: Record<string, number> = {};
  const stand = standLabel(stands);

  async function record(step: string, actor: string, txHash: string, durationMs: number,
    timings: { renderMs: number; uploadMs: number; chainMs: number }) {
    const receipt = await ethers.provider.getTransactionReceipt(txHash);
    const gas = Number(receipt!.gasUsed);
    gasByActor[actor] = (gasByActor[actor] ?? 0) + gas;
    const total = Math.round(durationMs);
    const row: Row = {
      run: runNo, scenarioId, qualityProfile: profileId, chain, stand, repetition, step, actor, txHash, gasUsed: gas,
      gasPriceWei: receipt!.gasPrice.toString(), feeWei: receipt!.fee.toString(), durationMs: total,
      renderMs: timings.renderMs, uploadMs: timings.uploadMs, chainMs: timings.chainMs,
      otherMs: total - timings.renderMs - timings.uploadMs - timings.chainMs
    };
    if (batchId > 0n) Object.assign(row, await snapshot(batchId));
    runSteps.push(row);
    steps.push(row);
    return row;
  }

  async function onChain(step: string, actor: string, send: () => Promise<any>) {
    const t0 = performance.now();
    const tx = await send();
    try {
      await tx.wait(1, TX_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`${step}: transaction ${tx.hash} was not confirmed within ${TX_TIMEOUT_MS} ms`, { cause: error });
    }
    const durationMs = performance.now() - t0;
    return record(step, actor, tx.hash, durationMs, { renderMs: 0, uploadMs: 0, chainMs: Math.round(durationMs) });
  }
  async function viaSimulator(step: string, actor: string, path: string, body: unknown) {
    const t0 = performance.now();
    const result = await post(path, body);
    const row = await record(step, actor, result.transactionHash, performance.now() - t0, result.timings);
    row.note = result.ipfsCid ? `cid=${result.ipfsCid}` : "";
    return result;
  }

  async function transportLeg(from: typeof beekeeper, fromName: string, to: string, toName: string) {
    await onChain(`transferCustody(${fromName}->logistics)`, fromName, () =>
      supplyChain.connect(from).transferCustody(batchId, logistics.address));
    const reading = await post(sensorPath("transport", "NORMAL"));
    await onChain("recordTransportData", "logistics", () =>
      supplyChain.connect(logistics).recordTransportData(batchId, reading.temperatureCelsius, reading.durationMinutes));
    await onChain(`transferCustody(logistics->${toName})`, "logistics", () =>
      supplyChain.connect(logistics).transferCustody(batchId, to));
  }

  const grams = stands.reduce((sum, s) => sum + s.grams, 0);
  const jars = Math.floor(grams / JAR_GRAMS);

  const siResponses: any[] = [];
  for (const s of stands) {
    siResponses.push(await post("/si", { sensorStation: STATIONS[s.standId].name, waterSourceDistanceMeters: s.distance }));
  }
  const si = Object.fromEntries(SI_KEYS.map((key) => [key,
    Math.round(stands.reduce((sum, s, i) => sum + siResponses[i][key] * s.grams, 0) / grams)])) as Record<typeof SI_KEYS[number], number>;

  const region = profile?.region ?? (run.generatedRegion as string);

  await viaSimulator("certification", "certBody", "/certifications",
    { beekeeperAddress: beekeeper.address, force: profile?.certification ?? "NONE" });

  batchId = await supplyChain.nextBatchId();
  await onChain("registerHarvestBatch", "beekeeper", () =>
    supplyChain.connect(beekeeper).registerHarvestBatch(2026, stands.map((s) => s.standId), stands.map((s) => s.grams)));

  await onChain("submitSIData", "beekeeper", () => qualityIndex.connect(beekeeper).submitSIData(batchId, si));

  const origin = await post("/mci/origin", { region });
  const originUpload = await post("/origin", { regions: stands.map((s) => STATIONS[s.standId].name) });
  const originRow = await onChain("submitOrigin", "beekeeper", () =>
    qualityIndex.connect(beekeeper).submitOrigin(batchId, origin.region, cidToBytes32(originUpload.cid)));
  originRow.note = `cid=${originUpload.cid}`;

  const labResult = await viaSimulator("labAnalysis", "lab", "/lab/analysis",
    { batchId: Number(batchId), force: profile?.labForce ?? "NORMAL", variety: profile?.variety });

  const afterLab = await snapshot(batchId);
  const notSellable = afterLab.state === "NotSellable";

  if (!notSellable) {
    if (profile?.award) {
      await viaSimulator("award", "awardBody", "/awards", { batchId: Number(batchId), force: profile.award });
    }

    const processor = chain === "FULL" ? bottler : beekeeper;
    const processorName = chain === "FULL" ? "bottler" : "beekeeper";

    const warehouse = await post(sensorPath("warehouse", "NORMAL"));
    await onChain("recordWarehouseData(lager)", "beekeeper", () =>
      supplyChain.connect(beekeeper).recordWarehouseData(batchId, warehouse.temperatureCelsius, warehouse.durationMinutes));

    if (chain === "FULL") {
      await transportLeg(beekeeper, "beekeeper", bottler.address, "bottler");
    }

    const defrost = await post(sensorPath("defrost", defrostViolation ? "VIOLATION" : "NORMAL"));
    await onChain("recordWarehouseData(defrost)", processorName, () =>
      supplyChain.connect(processor).recordWarehouseData(batchId, defrost.temperatureCelsius, defrost.durationMinutes));

    if (defrostViolation) {
      const afterDefrost = await snapshot(batchId);
      if (afterDefrost.state !== "RetestRequired") {
        throw new Error(`${scenarioId}: expected RetestRequired after the forced defrost violation, got ${afterDefrost.state}`);
      }

      await viaSimulator("labRetest", "lab", "/lab/analysis",
        { batchId: Number(batchId), previousReport: labResult.reportData });
      const afterRetest = await snapshot(batchId);
      if (afterRetest.state !== "Active") {
        throw new Error(`${scenarioId}: expected Active after the retest, got ${afterRetest.state}`);
      }
    }

    await onChain("processAndBottle", processorName, () =>
      supplyChain.connect(processor).processAndBottle(batchId, [JAR_GRAMS], [jars]));
    bottled = true;

    if (chain !== "DIRECT") {
      await transportLeg(processor, processorName, retailer.address, "retailer");
    }
  }

  const t0 = performance.now();
  const final = await snapshot(batchId);
  const consumerQueryMs = Math.round(performance.now() - t0);

  const sum = (key: string) => runSteps.reduce((total, r) => total + Number(r[key]), 0);
  const totalGas = sum("gasUsed");
  const summary: Row = {
    run: runNo, scenarioId, qualityProfile: profileId, chain, stand, repetition,
    batchId: Number(batchId), grams, jars: bottled ? jars : 0,
    custodyTransfers: runSteps.filter((r) => String(r.step).startsWith("transferCustody")).length,
    totalGas, ...Object.fromEntries(Object.entries(gasByActor).map(([a, g]) => [`gas_${a}`, g])),
    offChainMs: sum("renderMs") + sum("uploadMs"), onChainMs: sum("chainMs"),
    finalQi: final.qi, finalState: final.state, finalPriceCents: final.priceCents, consumerQueryMs
  };
  summary.upliftEurPerJar = typeof final.priceCents === "number" ? (final.priceCents - FLOOR_PRICE_CENTS) / 100 : "";
  for (const gwei of GWEI_ASSUMPTIONS) {
    const costEur = totalGas * gwei * 1e-9 * ETH_EUR;
    summary[`costEurPerJar_${gwei}gwei`] = bottled ? Number((costEur / jars).toFixed(4)) : "";
  }
  summary.ethEurAssumption = ETH_EUR;

  const sim = simReference.scenarios[simKey(scenarioId, stands)];
  if (sim) {
    summary.simQi = sim.qi;
    summary.simPriceCents = sim.priceCents ?? "not sellable";
    summary.simQiDeviation = Number((Number(final.qi) / 10000 - sim.qi).toFixed(4));
    summary.simPriceDeviationCents = typeof final.priceCents === "number" && sim.priceCents != null
      ? final.priceCents - sim.priceCents : "";
  }

  if (defrostViolation) {
    const preRetestSim = simReference.scenarios[`${scenarioId}_preRetest`];
    summary.preRetestQi = Number(afterLab.qi);
    if (preRetestSim) {
      summary.preRetestSimQi = preRetestSim.qi;
      summary.preRetestQiDeviation = Number((Number(afterLab.qi) / 10000 - preRetestSim.qi).toFixed(4));
    }
  }
  return summary;
}

function toCsv(rows: Row[]): string {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n");
}

const steps: Row[] = [];
const runSummaries: Row[] = [];

const dir = `results/${new Date().toISOString().replaceAll(":", "-")}`;
mkdirSync(dir, { recursive: true });

function writeResults() {
  writeFileSync(`${dir}/steps.csv`, toCsv(steps));
  writeFileSync(`${dir}/runs.csv`, toCsv(runSummaries));
  writeFileSync(`${dir}/raw.json`, JSON.stringify({ steps, runs: runSummaries }, null, 2));
}

for (const [index, run] of runs.entries()) {
  const low = await lowBalanceSigner();
  if (low) {
    console.error(`\nStopping before run ${index + 1}/${runs.length}: ${low}`);
    break;
  }
  console.log(`[${index + 1}/${runs.length}] ${run.scenarioId} ${standLabel(run.stands)} rep${run.repetition} (${run.chain})`);
  try {
    runSummaries.push(await runBatch(index + 1, run, steps));
  } catch (error) {
    console.error(`  FAILED: ${(error as Error).message}`);
    runSummaries.push({ run: index + 1, scenarioId: run.scenarioId, stand: standLabel(run.stands), repetition: run.repetition, error: (error as Error).message });
  }
  writeResults();
}

console.log(`\nResults in ${dir}`);

console.log("\nÜbersicht (erste Wiederholung je Szenario/Stand):");
const seen = new Set<string>();
for (const r of runSummaries) {
  const key = `${r.scenarioId}/${r.stand}`;
  if (seen.has(key) || r.error) continue;
  seen.add(key);
  console.log(`  ${String(r.scenarioId).padEnd(6)} ${String(r.stand).padEnd(10)} QI=${r.finalQi} (sim ${r.simQi ?? "-"}, Δ${r.simQiDeviation ?? "-"})  ` +
    `Preis=${r.finalPriceCents}c (sim ${r.simPriceCents ?? "-"}, Δ${r.simPriceDeviationCents ?? "-"})  Zustand=${r.finalState}  Gas=${r.totalGas}`);
}

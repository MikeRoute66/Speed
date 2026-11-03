(() => {
const isBrowserEnvironment =
  typeof window !== "undefined" && typeof document !== "undefined";
const check2d = globalThis.check2d;
if (isBrowserEnvironment && (!check2d || !check2d.System)) {
  throw new Error("check2d library not found. Ensure lib/check2d/index.js is loaded before main.js.");
}

const System = check2d?.System ?? null;

const physicsLib = globalThis.RockportPhysics;
if (!physicsLib || !physicsLib.Car) {
  throw new Error(
    "Rockport physics library not found. Ensure carPhysics.js is loaded before main.js."
  );
}
const { Car: PhysicsCar, defaultCarConfig } = physicsLib;
const PIXELS_PER_METER = 16;

const TILE_SIZE = 256;
const RAD2DEG = 180 / Math.PI;
const MPH_TO_METERS_PER_SECOND = 0.44704;

// global queue for road-spawn requests (helps when roads are created before TrafficManager exists)
if (!globalThis.__pendingRoadSpawns) {
  globalThis.__pendingRoadSpawns = [];
}

if (!globalThis.__pendingTrafficTiles) {
  globalThis.__pendingTrafficTiles = [];
}

if (!globalThis.__pendingRoadLineSpawns) {
  globalThis.__pendingRoadLineSpawns = [];
}

const ZERO_INPUT = Object.freeze({
  forward: false,
  reverse: false,
  left: false,
  right: false,
  brake: false
});

const TRAFFIC_DIRECTIONS = Object.freeze({
  N: { dx: 0, dy: -1, angle: -Math.PI / 2 },
  S: { dx: 0, dy: 1, angle: Math.PI / 2 },
  E: { dx: 1, dy: 0, angle: 0 },
  W: { dx: -1, dy: 0, angle: Math.PI }
});

const ROAD_TILE_CODES = new Set(["R", "V", "I", "S"]);
const COLLISION_FORWARD_SPEED_THRESHOLD = 0.5;
const DIR_TO_INDEX = { E: 0, S: 1, W: 2, N: 3 };
const TURN_RADIUS_RIGHT = Math.SQRT2 * (TILE_SIZE / 4);
const TURN_RADIUS_LEFT = Math.SQRT2 * (TILE_SIZE * 0.75);
const TURN_RADIUS_UTURN = TILE_SIZE / 2;
const TURN_SEGMENTS = Object.freeze({
  right: 6,
  left: 8,
  uturn: 12
});
const LINE_TARGET_TIMEOUT = 5;
const TIME_TRIALS_PER_CITY_CHUNK = 5;
const TIME_TRIAL_MIN_LENGTH = 12;
const TIME_TRIAL_MAX_LENGTH = 50;
const TIME_TRIAL_EDGE_MARGIN = 18;
const TIME_TRIAL_LINE_HALF_SPAN = TILE_SIZE / 2 - TIME_TRIAL_EDGE_MARGIN;
const AI_RACES_PER_CITY_CHUNK = 1;
const AI_RACE_OPPONENT_COUNT = 3;
const AI_RACE_CHECKPOINT_THRESHOLD = Math.max(8, TILE_SIZE * 0.15);
let VEHICLE_ID_SEQUENCE = 1;
function oppositeDirection(dir) {
  switch (dir) {
    case "N":
      return "S";
    case "S":
      return "N";
    case "E":
      return "W";
    case "W":
      return "E";
    default:
      return null;
  }
}

function directionToAngle(dir) {
  switch (dir) {
    case "E":
      return 0;
    case "W":
      return Math.PI;
    case "S":
      return Math.PI / 2;
    case "N":
      return -Math.PI / 2;
    default:
      return 0;
  }
}

function formatOrdinal(value) {
  const abs = Math.abs(Math.trunc(value));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${abs}th`;
  }
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

function normalizeAngle(angle) {
  let value = angle;
  while (value <= -Math.PI) {
    value += Math.PI * 2;
  }
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  return value;
}

const SAVEGAME_STORAGE_KEY = "rockport.savegame.v1";
const SAVEGAME_SCHEMA_VERSION = 2;
const MAX_SAVE_SLOTS = 12;

const isNodeEnvironment =
  typeof process !== "undefined" && process.versions && process.versions.node;
let carVerificationManager = null;

function cloneCarConfig(config) {
  if (!config || typeof config !== "object") {
    return {};
  }
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(config);
    } catch (error) {
      // Fallback below if structuredClone fails (e.g., due to functions in object).
    }
  }
  return JSON.parse(JSON.stringify(config));
}

function getSaveStorage() {
  try {
    if (typeof globalThis.localStorage !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch (_error) {
    // Ignore storage access errors (e.g., privacy modes).
  }
  return null;
}

function createSlotFromPayload(payload, id) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const savedAt = Number.isFinite(payload.savedAt) ? payload.savedAt : Date.now();
  const carLabel =
    typeof payload.carLabel === "string" && payload.carLabel.trim().length > 0
      ? payload.carLabel.trim()
      : "Vehicle";
  return {
    id,
    name: buildDefaultSaveName(carLabel, savedAt),
    savedAt,
    carId: payload.carId ?? null,
    carLabel,
    mode: payload.mode === "onFoot" ? "onFoot" : "driving",
    data: payload
  };
}

function buildDefaultSaveName(carLabel, timestamp) {
  const base = carLabel && carLabel.trim().length > 0 ? carLabel.trim() : "Vehicle";
  if (!Number.isFinite(timestamp)) {
    return base;
  }
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return base;
    }
    const time = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    });
    return `${base} - ${time}`;
  } catch (_error) {
    return base;
  }
}

function readSaveStore() {
  const storage = getSaveStorage();
  const empty = { slots: [], nextId: 1 };
  if (!storage) {
    return { ...empty };
  }
  try {
    const raw = storage.getItem(SAVEGAME_STORAGE_KEY);
    if (!raw) {
      return { ...empty };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...empty };
    }

    // Already in the new schema.
    if (Array.isArray(parsed.slots)) {
      const normalized = [];
      let highestId = 0;
      let needsRewrite = false;

      parsed.slots.forEach((slot) => {
        if (!slot || typeof slot !== "object" || !slot.data) {
          return;
        }
        const savedAt = Number.isFinite(slot.savedAt) ? slot.savedAt : Date.now();
        const carLabel =
          typeof slot.carLabel === "string" && slot.carLabel.trim().length > 0
            ? slot.carLabel.trim()
            : "Vehicle";
        const hasName = typeof slot.name === "string" && slot.name.trim().length > 0;
        const rawId = Number.isFinite(slot.id) ? slot.id : null;
        if (Number.isFinite(rawId)) {
          highestId = Math.max(highestId, rawId);
        } else {
          needsRewrite = true;
        }
        normalized.push({
          id: rawId,
          name: hasName ? slot.name.trim() : buildDefaultSaveName(carLabel, savedAt),
          savedAt,
          carId: slot.carId ?? null,
          carLabel,
          mode: slot.mode === "onFoot" ? "onFoot" : "driving",
          data: slot.data
        });
      });

      normalized.sort((a, b) => b.savedAt - a.savedAt);

      if (normalized.length > MAX_SAVE_SLOTS) {
        normalized.splice(MAX_SAVE_SLOTS);
        needsRewrite = true;
      }

      let nextId =
        Number.isFinite(parsed.nextId) && parsed.nextId > highestId
          ? parsed.nextId
          : highestId + 1;
      if (!Number.isFinite(parsed.nextId) || parsed.nextId <= highestId) {
        needsRewrite = true;
      }

      normalized.forEach((slot) => {
        if (!Number.isFinite(slot.id)) {
          slot.id = nextId;
          nextId += 1;
          needsRewrite = true;
        }
      });

      if (needsRewrite) {
        writeSaveStore({ slots: normalized, nextId });
      }

      return {
        slots: normalized,
        nextId
      };
    }

    // Legacy single-save payload (schema v1).
    if (parsed.version === 1 && parsed.savedAt !== undefined) {
      const slot = createSlotFromPayload(parsed, 1);
      if (slot) {
        const migrated = { slots: [slot], nextId: 2 };
        writeSaveStore(migrated);
        return migrated;
      }
    }
  } catch (error) {
    console.warn("Failed to read saved games:", error);
  }
  return { slots: [], nextId: 1 };
}

function writeSaveStore(store) {
  const storage = getSaveStorage();
  if (!storage) {
    return false;
  }
  try {
    const slots = Array.isArray(store?.slots) ? store.slots.slice() : [];
    slots.sort((a, b) => b.savedAt - a.savedAt);
    const limitedSlots = slots.slice(0, MAX_SAVE_SLOTS);
    const nextId = Number.isFinite(store?.nextId) ? Math.max(1, store.nextId) : slots.length + 1;
    const payload = {
      version: SAVEGAME_SCHEMA_VERSION,
      nextId,
      slots: limitedSlots.map((slot) => ({
        id: slot.id,
        name: slot.name,
        savedAt: slot.savedAt,
        carId: slot.carId ?? null,
        carLabel: slot.carLabel ?? null,
        mode: slot.mode === "onFoot" ? "onFoot" : "driving",
        data: slot.data ?? null
      }))
    };
    storage.setItem(SAVEGAME_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn("Failed to persist saved games:", error);
    return false;
  }
}

function listSaveSlots() {
  const store = readSaveStore();
  return store.slots ? store.slots.slice().sort((a, b) => b.savedAt - a.savedAt) : [];
}

function getSaveSlot(slotId) {
  if (!Number.isFinite(slotId)) {
    return null;
  }
  const store = readSaveStore();
  return store.slots.find((slot) => slot.id === slotId) ?? null;
}

function addSaveSlot(payload) {
  const basePayload = payload && typeof payload === "object" ? { ...payload } : null;
  if (!basePayload) {
    return null;
  }
  const store = readSaveStore();
  const slotId = store.nextId ?? 1;
  const slot = createSlotFromPayload(basePayload, slotId);
  if (!slot) {
    return null;
  }

  const existing = Array.isArray(store.slots) ? store.slots.slice() : [];
  existing.unshift(slot);
  existing.sort((a, b) => b.savedAt - a.savedAt);
  const trimmed = existing.slice(0, MAX_SAVE_SLOTS);
  const nextId = slotId + 1;

  writeSaveStore({ slots: trimmed, nextId });
  return slot;
}

function removeSaveSlot(slotId) {
  if (!Number.isFinite(slotId)) {
    return false;
  }
  const store = readSaveStore();
  const filtered = store.slots.filter((slot) => slot.id !== slotId);
  if (filtered.length === store.slots.length) {
    return false;
  }
  writeSaveStore({ slots: filtered, nextId: store.nextId });
  return true;
}

function clearSavedGame() {
  return writeSaveStore({ slots: [], nextId: 1 });
}

function formatSaveTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (_error) {
    return null;
  }
}

const WORLD_SEED = 0x6ac5d;

const IMAGE_SOURCES = {
  tile_grass: "assets/tile_grass.png",
  tile_road: "assets/tile_road.png",
  tile_road_vertical: "assets/tile_road_vertical.png",
  tile_intersection: "assets/tile_intersection.png",
  tile_water: "assets/tile_water.png",
  building_apartment: "assets/building_apartment.png",
  building_diner: "assets/building_diner.png",
  building_factory: "assets/building_factory.png",
  building_hospital: "assets/building_hospital.png",
  // Car sprites (multiple styles). Use main assets folder under `assets/Car Sprites`.
  car_default: "assets/Car Sprites/Ferrari.png",
  car_Ferrari: "assets/Car Sprites/Ferrari.png",
  car_Porsche: "assets/Car Sprites/Porsche.png",
  car_Lamborghini: "assets/Car Sprites/Lamborgini.png",
  car_F1: "assets/Car Sprites/F1.png",
  car_Exotic: "assets/Car Sprites/Exotic.png",
  car_Classic_Car: "assets/Car Sprites/Classic Car.png",
  car_Classic_Racecar: "assets/Car Sprites/Classic Racecar.png",
  car_Modern_Muscle: "assets/Car Sprites/Modern Muscle.png",
  car_Retro_Muscle: "assets/Car Sprites/Retro Muscle.png",
  car_Sedan: "assets/Car Sprites/Sedan.png",
  car_Truck: "assets/Car Sprites/Truck.png",
  car_Police_Car: "assets/Car Sprites/Police Car.png",
  car_Hatchback: "assets/Car Sprites/Hatchback.png",
  car_Modern_Corvette: "assets/Car Sprites/Modern Corvette.png",
  car_Retro_Mustang: "assets/Car Sprites/Retro Mustang.png",
  player: "assets/player.png",
  checkpoint_flag: "assets/checkpoint_flag.png"
};

const TILESET = {
  W: { baseSprite: "tile_water", solid: true, color: "#0f172a" },
  G: { baseSprite: "tile_grass", solid: false, color: "#1b5e20" },
  R: { baseSprite: "tile_road", solid: false, color: "#3b3f46" },
  V: { baseSprite: "tile_road_vertical", solid: false, color: "#3b3f46" },
  I: { baseSprite: "tile_intersection", solid: false, color: "#3b3f46" },
  S: {
    baseSprite: "tile_intersection",
    solid: false,
    start: true,
    startAngle: 0
  },
  B: {
    baseSprite: "tile_grass",
    overlaySprite: "building_apartment",
    solid: true,
    collider: { width: 26, height: 52 }
  },
  D: {
    baseSprite: "tile_grass",
    overlaySprite: "building_diner",
    solid: true,
    collider: { width: 49, height: 26 }
  },
  F: {
    baseSprite: "tile_grass",
    overlaySprite: "building_factory",
    solid: true,
    collider: { width: 51, height: 45 }
  },
  H: {
    baseSprite: "tile_grass",
    overlaySprite: "building_hospital",
    solid: true,
    collider: { width: 52, height: 51 }
  }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MIN_ROAD_LENGTH = 5;
const CELL_SIZE = 96;
const BUILDING_CODES = ["B", "D", "F", "H"];
const ZONE_SIZE = 64;
const CITY_THRESHOLD = 64; // out of 256, ~25% city

function mod(value, modulo) {
  return ((value % modulo) + modulo) % modulo;
}

function hashCoordinates(x, y) {
  let hash = x * 374761393 + y * 668265263 + WORLD_SEED * 1597334677;
  hash = (hash ^ (hash >> 13)) >>> 0;
  return hash;
}

function getZone(x, y) {
  const regionX = Math.floor(x / ZONE_SIZE);
  const regionY = Math.floor(y / ZONE_SIZE);
  if (regionX === 0 && regionY === 0) {
    return "country";
  }
  const hash = hashCoordinates(regionX, regionY) & 0xff;
  return hash < CITY_THRESHOLD ? "city" : "country";
}

function clampToRange(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function chooseBuildingCode(x, y, zone) {
  const hash = hashCoordinates(x, y);
  const chanceMask = zone === "city" ? 0x3 : 0xf;
  const threshold = zone === "city" ? 2 : 1;
  if ((hash & chanceMask) < threshold) {
    return null;
  }
  return BUILDING_CODES[hash % BUILDING_CODES.length];
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", (event) => reject(event.error || new Error(`Failed to load ${url}`)));
    img.src = url;
  });
}

async function loadImages(sources) {
  const entries = await Promise.all(
    Object.entries(sources).map(async ([key, path]) => {
      const image = await loadImage(path);
      return [key, image];
    })
  );

  return Object.fromEntries(entries);
}

const CAR_CATALOG = Array.isArray(globalThis.RockportCarCatalog)
  ? [...globalThis.RockportCarCatalog]
  : [];

function ensureGearRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length === 0) {
    return defaultCarConfig().gearRatios.slice();
  }
  if (ratios[0] !== 0) {
    return [0, ...ratios];
  }
  return ratios.slice();
}

// Heuristic to pick the most fitting car sprite key for a given car spec.
// Returns one of the keys added into IMAGE_SOURCES (e.g. 'car_Ferrari', 'car_Modern_Muscle').
function chooseCarSprite(carSpec) {
  if (!carSpec) return "car_default";
  const make = String(carSpec.make || "").toLowerCase();
  const model = String(carSpec.model || "").toLowerCase();
  const year = Number(carSpec.year) || 0;
  const specs = carSpec.specs || carSpec;
  const hp = Number(specs.horsepower) || 0;
  const downforce = Number(specs.downforceCoefficient) || 0;
  // Brand-specific direct mappings
  if (make.includes("ferrari")) return "car_Ferrari";
  if (make.includes("porsche")) return "car_Porsche";
  if (make.includes("lamborghini") || make.includes("lamborgini")) return "car_Lamborghini";
  if (make.includes("bugatti") || make.includes("pagani") || make.includes("koenigsegg")) return "car_Exotic";

  // Corvettes -> dedicated Corvette sprite when available (catch early so concepts with high downforce don't become F1)
  if (make.includes("chevrolet") && model.includes("corvette")) {
    return year >= 1997 ? "car_Modern_Corvette" : "car_Classic_Car";
  }

  // Formula / open-wheel / very high-downforce race cars -> F1
  if (model.includes("f1") || downforce > 1.8 || /indianapolis|indy|formula/.test(model)) return "car_F1";

  // Corvettes -> dedicated Corvette sprite when available
  if (make.includes("chevrolet") && model.includes("corvette")) {
    // Treat Corvettes from 1997 onward as 'modern' (C5 and later)
    return year >= 1997 ? "car_Modern_Corvette" : "car_Classic_Car";
  }

  // Mustangs -> retro mustang for classics, modern muscle for newer
  if (make.includes("ford") && model.includes("mustang")) {
    return year < 1990 ? "car_Retro_Mustang" : year < 2018 ? "car_Modern_Muscle" : "car_Modern_Muscle";
  }

  // General muscle cars (Camaro, Challenger, Charger, etc.)
  const muscleModelHints = ["camaro", "challenger", "charger", "corvette", "mustang", "gt500", "gt500"];
  if (muscleModelHints.some((h) => model.includes(h)) || ["dodge", "pontiac", "plymouth", "buick"].some((m) => make.includes(m))) {
    return year >= 1990 ? "car_Modern_Muscle" : "car_Retro_Muscle";
  }

  // Hatchbacks and compact cars
  if (model.includes("hatch") || model.includes("golf") || model.includes("focus") || make.includes("volkswagen")) {
    return "car_Hatchback";
  }

  // Sedans / everyday cars
  const sedanMakes = ["acura", "audi", "bmw", "cadillac", "mercedes", "volkswagen", "toyota", "honda"];
  if (sedanMakes.some((m) => make.includes(m)) && !model.includes("gt") && hp < 500) {
    return "car_Sedan";
  }

  // Police / government vehicles (explicit match by model or make)
  if (model.includes("police") || make.includes("police")) return "car_Police_Car";

  // Truck / pickup detection: match common truck/pickup keywords or heavy mass
  const massKg = Number(specs.massKg ?? specs.mass ?? 0) || 0;
  const truckHints = [
    "truck",
    "pickup",
    "pick-up",
    "f150",
    "f-150",
    "silverado",
    "sierra",
    "ram",
    "tundra",
    "ranger",
    "navara",
    "lorry"
  ];
  if (truckHints.some((h) => model.includes(h) || make.includes(h)) || massKg >= 2200) {
    return "car_Truck";
  }

  // High horsepower or exotic-sounding models -> Exotic
  if (hp >= 800 || /zenvo|rimac|lotus|apollo|venom/.test(make + " " + model)) return "car_Exotic";

  // Fallbacks
  if (hp >= 600) return "car_Exotic";
  return "car_default";
}

function normalizeGripInput(input) {
  if (input == null) {
    return null;
  }
  if (Array.isArray(input)) {
    const values = input
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? values : null;
  }
  if (typeof input === "string") {
    const values = input
      .split(/[,;|]/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? values : null;
  }
  const num = Number(input);
  return Number.isFinite(num) ? [num] : null;
}

function ensureGripArray(values, fallbackArray, fallbackFactor) {
  const normalizedValues = normalizeGripInput(values);
  if (normalizedValues && normalizedValues.length >= 4) {
    return normalizedValues.slice(0, 4);
  }
  if (normalizedValues && normalizedValues.length > 0) {
    return [0, 1, 2, 3].map((index) => normalizedValues[index % normalizedValues.length]);
  }
  const normalizedFallback = normalizeGripInput(fallbackArray);
  if (normalizedFallback && normalizedFallback.length >= 4) {
    return normalizedFallback.slice(0, 4);
  }
  if (normalizedFallback && normalizedFallback.length > 0) {
    return [0, 1, 2, 3].map((index) => normalizedFallback[index % normalizedFallback.length]);
  }
  if (Array.isArray(fallbackArray) && fallbackArray.length === 0) {
    return undefined;
  }
  if (Number.isFinite(fallbackFactor) && fallbackFactor > 0 && normalizedValues && normalizedValues.length > 0) {
    return normalizedValues.map((value) => value * fallbackFactor);
  }
  if (Number.isFinite(fallbackFactor) && fallbackFactor > 0) {
    return undefined;
  }
  return undefined;
}

function computeBrakeHorsepower(horsepower) {
  if (!Number.isFinite(horsepower)) {
    return horsepower;
  }
  return horsepower * 0.82;
}

function computeFallbackBrakeTorque(config) {
  const wheelRadius = config.wheelRadiusM ?? defaultCarConfig().wheelRadiusM ?? 0.3;
  const brakeHp = config.brakeHorsepower ?? computeBrakeHorsepower(config.horsepower ?? defaultCarConfig().horsepower);
  const brakeBiasFront = config.brakeBiasFront ?? 0.6;
  const totalForce = (brakeHp * 745.7) / 30;
  const frontForce = totalForce * brakeBiasFront;
  const rearForce = totalForce - frontForce;
  const frontTorque = (frontForce / 2) * wheelRadius;
  const rearTorque = (rearForce / 2) * wheelRadius;
  return [frontTorque, frontTorque, rearTorque, rearTorque];
}

function createCarConfigFromSpec(spec = {}, context = {}) {
  const base = defaultCarConfig();
  if (!spec) {
    return base;
  }

  const baseLongGrips = Array.isArray(base.tireGrips) ? base.tireGrips : defaultCarConfig().tireGrips;
  const baseLatGrips =
    Array.isArray(base.tireLateralGrips) && base.tireLateralGrips?.length
      ? base.tireLateralGrips
      : null;
  const baseLatFactor = base.tireLateralGripFactor ?? 1.12;

  const tireGrips = ensureGripArray(
    spec.tireGrips ?? spec.tireGripLong ?? spec.tireGripLongitudinal,
    baseLongGrips
  ) ?? baseLongGrips.slice();

  const tireLateralInput =
    spec.tireGripLat ??
    spec.tireGripLateral ??
    spec.tireGripSide ??
    spec.tireGripLatitudinal;
  const tireLateralGrips =
    ensureGripArray(
      tireLateralInput,
      baseLatGrips ?? tireGrips.map((value) => value * baseLatFactor),
      spec.tireLateralGripFactor ?? baseLatFactor
    ) ?? tireGrips.map((value) => value * (spec.tireLateralGripFactor ?? baseLatFactor));

  const config = {
    ...base,
    massKg: spec.massKg ?? base.massKg,
    driveType: spec.driveType ?? base.driveType,
    gearRatios: ensureGearRatios(spec.gearRatios),
    finalDriveRatio: spec.finalDrive ?? base.finalDriveRatio,
    horsepower: spec.horsepower ?? base.horsepower,
    peakTorqueNm: spec.torqueNm ?? base.peakTorqueNm,
    brakeHorsepower: spec.brakeHorsepower ?? computeBrakeHorsepower(spec.horsepower ?? base.horsepower),
    dragCoefficient: spec.dragCoefficient ?? base.dragCoefficient,
    downforceCoefficient: spec.downforceCoefficient ?? base.downforceCoefficient,
    frontalAreaM2: spec.frontalAreaM2 ?? base.frontalAreaM2,
    wheelRadiusM: spec.wheelRadiusM ?? base.wheelRadiusM,
    tireGrips,
    tireLateralGrips,
    tireLateralGripFactor: spec.tireLateralGripFactor ?? baseLatFactor,
    wheelbaseM: spec.wheelbaseM ?? base.wheelbaseM,
    cgHeightM: spec.cgHeightM ?? base.cgHeightM,
    trackWidthM: spec.trackWidthM ?? base.trackWidthM,
    frontWeightDistribution: spec.frontWeightDistribution ?? base.frontWeightDistribution,
    drivetrainEfficiency: spec.drivetrainEfficiency ?? base.drivetrainEfficiency,
    rollingResistanceCoeff: spec.rollingResistanceCoeff ?? base.rollingResistanceCoeff,
    revLimiterRpm: spec.revLimiterRpm ?? base.revLimiterRpm ?? 7000,
    brakeBiasFront: spec.brakeBiasFront ?? base.brakeBiasFront ?? 0.6
  };

  // Apply any per-spec local calibration overrides (hand-tuned values stored in the spec)
  if (spec && typeof spec === "object" && spec.calibrationOverrides && typeof spec.calibrationOverrides === "object") {
    const localKeys = ["dragCoefficient", "rollingResistanceCoeff", "drivetrainEfficiency"];
    for (const key of localKeys) {
      if (Object.prototype.hasOwnProperty.call(spec.calibrationOverrides, key)) {
        const v = spec.calibrationOverrides[key];
        const num = Number(v);
        if (Number.isFinite(num)) {
          config[key] = num;
        }
      }
    }
  }

  config.brakeTorquePerWheelNm =
    ensureGripArray(
      spec.brakeTorquePerWheelNm ??
        spec.brakeTorquePerWheel ??
        spec.brakeTorque ??
        spec.brakeTorqueNm,
      base.brakeTorquePerWheelNm
    ) ?? computeFallbackBrakeTorque(config);

  if (context.applyOverrides !== false && carVerificationManager) {
    const potentialId = context.carId ?? spec?.carId ?? spec?.id ?? context?.carSpec?.id;
    if (potentialId) {
      const overrides = carVerificationManager.getOverrides(potentialId);
      if (overrides && typeof overrides === "object") {
        const overrideKeys = ["dragCoefficient", "rollingResistanceCoeff", "drivetrainEfficiency"];
        for (const key of overrideKeys) {
          if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            const value = overrides[key];
            if (Number.isFinite(value)) {
              config[key] = value;
            }
          }
        }
      }
    }
  }

  return config;
}

function formatCarLabel(car) {
  if (!car) {
    return "-";
  }
  const parts = [
    car.year ? String(car.year) : null,
    car.make,
    car.model,
    car.variant ? `(${car.variant})` : null
  ].filter(Boolean);
  return parts.join(" ");
}

function buildCarSummary(car) {
  if (!car || !car.specs) {
    return "Select a car to view performance details.";
  }
  const spec = car.specs;
  const hp = spec.horsepower ?? "—";
  const torque = spec.torqueNm ?? "—";
  const mass = spec.massKg ?? "—";
  const drive = spec.driveType ?? "—";
  return `${formatCarLabel(car)} — ${drive}, ${hp} hp, ${torque} Nm, ${mass} kg.`;
}

CAR_CATALOG.sort((a, b) => formatCarLabel(a).localeCompare(formatCarLabel(b)));

const CAR_VERIFICATION_VERSION = 1;

class CarVerificationManager {
  constructor(options = {}) {
    this.storageKey = options.storageKey ?? "rockport.verification.v1";
    this.version = options.version ?? CAR_VERIFICATION_VERSION;
    this.records = new Map();
    this.overrides = new Map();
    this.initialized = false;
    this.logger = options.logger ?? console;
    this.fs = null;
    this.path = null;
    this.specFilePath = null;
    if (isNodeEnvironment && typeof require === "function") {
      try {
        // eslint-disable-next-line global-require
        this.fs = require("fs");
        // eslint-disable-next-line global-require
        this.path = require("path");
        const baseDir = typeof __dirname === "string" ? __dirname : process.cwd();
        this.specFilePath = this.path.resolve(baseDir, "carSpecs.js");
      } catch (error) {
        this.fs = null;
        this.path = null;
        this.specFilePath = null;
      }
    }
  }

  applyRecordToSpec(car, record) {
    const spec = car?.specs;
    if (!spec || typeof spec !== "object") {
      return false;
    }
    const verified = Boolean(record && record.verified === true);
    const previous = spec.performanceVerified === true;
    if (previous !== verified) {
      spec.performanceVerified = verified;
      return true;
    }
    return false;
  }

  isSpecMarkedVerified(car) {
    const spec = car?.specs;
    if (!spec || typeof spec !== "object") {
      return false;
    }
    return spec.performanceVerified === true;
  }

  markSpecVerified(car, flag) {
    const spec = car?.specs;
    if (!spec || typeof spec !== "object") {
      return;
    }
    spec.performanceVerified = !!flag;
  }


  persistSpecFlag(car, flag) {
    if (!isNodeEnvironment || !this.fs || !this.specFilePath || !car || !car.id) {
      return;
    }
    try {
      const content = this.fs.readFileSync(this.specFilePath, "utf8");
      const pattern = `(id: "${escapeRegex(car.id)}"[\\s\\S]*?performanceVerified:\\s*)(true|false)(,?)`;
      const regex = new RegExp(pattern, "m");
      if (!regex.test(content)) {
        return;
      }
      const updated = content.replace(regex, `$1${flag ? "true" : "false"}$3`);
      if (updated !== content) {
        this.fs.writeFileSync(this.specFilePath, updated, "utf8");
        this.logger?.info?.(`[CarVerification] Updated carSpecs entry for ${car.id} (${flag ? "verified" : "pending"})`);
      }
    } catch (_error) {
      // ignore write failures
    }
  }


  supportsStorage() {
    try {
      return typeof globalThis.localStorage !== "undefined";
    } catch (_error) {
      return false;
    }
  }

  ensureInitializedSync() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    if (!this.supportsStorage()) {
      return;
    }
    try {
      const raw = globalThis.localStorage.getItem(this.storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      for (const [carId, record] of Object.entries(parsed)) {
        if (!record || typeof record !== "object") {
          continue;
        }
        this.records.set(carId, record);
        if (this.isRecordCurrent(record) && record.overrides) {
          this.overrides.set(carId, record.overrides);
        }
      }
    } catch (error) {
      this.logger?.warn?.("Failed to read car verification data:", error);
      this.records.clear();
      this.overrides.clear();
    }
  }

  async ensureInitialized() {
    this.ensureInitializedSync();
  }

  isRecordCurrent(record) {
    return Boolean(record && record.version === this.version && record.verified === true);
  }

  getOverrides(carId) {
    if (!carId) {
      return null;
    }
    this.ensureInitializedSync();
    return this.overrides.get(carId) ?? null;
  }

  async verifyAllCars(cars = [], options = {}) {
    this.ensureInitializedSync();
    if (!Array.isArray(cars) || cars.length === 0) {
      return;
    }

    const visualizer = options?.visualizer ?? null;
    const limit = Number.isFinite(options?.limit)
      ? Math.max(0, Math.floor(options.limit))
      : null;
    // Per-car calibration timeout (ms) and max iterations for more-aggressive tuning
    const perCarTimeoutMs = Number.isFinite(options?.perCarTimeoutMs)
      ? Math.max(0, Math.floor(options.perCarTimeoutMs))
      : 120000; // default 2 minutes
    const maxIterations = Number.isFinite(options?.maxIterations)
      ? Math.max(1, Math.floor(options.maxIterations))
      : 12; // increase default iteration budget from 5 to 12

    if (limit !== null) {
      this.logger?.info?.(`[CarVerification] Limiting calibration to ${limit} vehicles for this run.`);
    }

    const pending = [];
    let changed = false;
    for (const car of cars) {
      if (!car || !car.id) {
        continue;
      }
      const existing = this.records.get(car.id);
      let specIsVerified = this.isSpecMarkedVerified(car);
      const specUpdatedFromRecord = existing ? this.applyRecordToSpec(car, existing) : false;
      if (specUpdatedFromRecord) {
        specIsVerified = this.isSpecMarkedVerified(car);
      }

      if (this.isRecordCurrent(existing) && specIsVerified) {
        if (specUpdatedFromRecord) {
          changed = true;
        }
        if (existing.overrides) {
          this.overrides.set(car.id, existing.overrides);
        } else {
          this.overrides.delete(car.id);
        }
        continue;
      }

      if (specIsVerified) {
        const spec = car?.specs ?? {};
        const targets = this.extractTargets(spec);
        const record = {
          version: this.version,
          verified: true,
          overrides: existing?.overrides ?? null,
          measured: existing?.measured ?? null,
          target: existing?.target ?? targets,
          iterations: existing?.iterations ?? 0,
          updatedAt: Date.now(),
          note: "Marked verified via CarSpecs performance flag."
        };
        this.records.set(car.id, record);
        if (record.overrides) {
          this.overrides.set(car.id, record.overrides);
        } else {
          this.overrides.delete(car.id);
        }
        this.markSpecVerified(car, true);
        this.persistSpecFlag(car, true);
        changed = true;
        continue;
      }

      pending.push(car);
      if (limit !== null && pending.length >= limit) {
        break;
      }
    }

    if (pending.length === 0) {
      if (changed) {
        this.persist();
      }
      return;
    }

    this.logger?.info?.(
      `[CarVerification] Calibrating ${pending.length} unverified car${pending.length === 1 ? "" : "s"} on the blank test track...`
    );

    let processed = 0;
    const total = pending.length;
    for (const car of pending) {
      processed += 1;
      const label = formatCarLabel(car) || car.id || "unknown";
      this.logger?.info?.(
        `[CarVerification] (${processed}/${total}) verifying ${label}...`
      );
      try {
        const record = this.runCalibration(car, {
          timeoutMs: perCarTimeoutMs,
          maxIterations: maxIterations
        });

        // If calibration timed out or failed to converge, record.verified will be false.
        if (!record || record.verified !== true) {
          this.records.set(car.id, record || {
            version: this.version,
            verified: false,
            error: "Calibration failed or timed out"
          });
          this.markSpecVerified(car, false);
          this.persistSpecFlag(car, false);
          this.logger?.warn?.(`[CarVerification] ${label} left unverified: ${record?.note ?? "timeout/failure"}`);
          changed = true;
          continue;
        }

        const playbackSamples = record.samples ?? null;
        const calibratedConfig =
          visualizer && record.calibratedConfig
            ? cloneCarConfig(record.calibratedConfig)
            : null;
        if (visualizer && playbackSamples) {
          try {
            await visualizer.play({
              car,
              record,
              calibratedConfig
            });
          } catch (visualError) {
            this.logger?.warn?.(
              `[CarVerification] Visualization failed for ${label}: ${visualError}`
            );
          }
        }
        if (record.samples) {
          delete record.samples;
        }
        if (record.calibratedConfig) {
          delete record.calibratedConfig;
        }
        this.records.set(car.id, record);
        if (record.overrides) {
          this.overrides.set(car.id, record.overrides);
        } else {
          this.overrides.delete(car.id);
        }
        this.markSpecVerified(car, true);
        this.persistSpecFlag(car, true);
        const zeroDiff =
          Number.isFinite(record?.measured?.zeroToHundredSec) &&
          Number.isFinite(record?.target?.zeroToHundredSec)
            ? Math.abs(record.measured.zeroToHundredSec - record.target.zeroToHundredSec).toFixed(2)
            : "n/a";
        const topDiff =
          Number.isFinite(record?.measured?.topSpeedKph) &&
          Number.isFinite(record?.target?.topSpeedKph)
            ? Math.abs(record.measured.topSpeedKph - record.target.topSpeedKph).toFixed(1)
            : "n/a";
        this.logger?.info?.(
          `[CarVerification] ${label} verified (Δ0-100: ${zeroDiff}s, ΔVmax: ${topDiff} km/h).`
        );
        changed = true;
      } catch (error) {
        this.logger?.error?.(`Car verification failed for ${car?.id ?? "unknown"}.`, error);
        this.records.set(car?.id ?? `error-${Date.now()}`, {
          version: this.version,
          verified: false,
          error: String(error)
        });
        this.logger?.warn?.(
          `[CarVerification] ${label} left unverified due to error: ${error}`
        );
        this.markSpecVerified(car, false);
        this.persistSpecFlag(car, false);
        changed = true;
      }

      if (limit !== null && processed >= limit) {
        break;
      }
    }

    this.persist();
  }

  runCalibration(car, options = {}) {
    const spec = car?.specs || {};
    const targets = this.extractTargets(spec);
    if (!targets) {
      this.markSpecVerified(car, true);
      return {
        version: this.version,
        verified: true,
        overrides: null,
        measured: {
          zeroToHundredSec: null,
          zeroToHundredReached: false,
          topSpeedKph: null,
          topSpeedDurationSec: 0
        },
        target: null,
        iterations: 0,
        updatedAt: Date.now(),
        note: "No performance targets provided; skipped calibration."
      };
    }
    const baseConfig = createCarConfigFromSpec(spec, {
      carId: car?.id,
      applyOverrides: false
    });
    const workingConfig = cloneCarConfig(baseConfig);

    const hasZeroToHundred = Number.isFinite(targets.zeroToHundredSec);
    const hasTopSpeed = Number.isFinite(targets.topSpeedKph);

    let measuredZero = { timeSec: null, reached: false };
    let measuredTop = { maxSpeedKph: null, durationSec: 0 };
    const zeroSamples = [];
    const topSamples = [];

    const timeoutMs = Number.isFinite(options?.timeoutMs) ? Math.max(0, Number(options.timeoutMs)) : 120000;
    const deadline = Date.now() + timeoutMs;
    const maxIterations = Number.isFinite(options?.maxIterations) ? Math.max(1, Math.floor(options.maxIterations)) : 12;

    let actualIterations = 0;
    let timedOut = false;
    for (let index = 0; index < maxIterations; index += 1) {
      actualIterations = index + 1;

      // Abort if we've exceeded wall-clock deadline
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      let accelClose = true;
      if (hasZeroToHundred) {
        measuredZero = this.measureZeroToHundred(workingConfig, { deadlineMs: deadline });
        accelClose = this.isWithinTolerance(
          measuredZero.timeSec,
          targets.zeroToHundredSec,
          0.04
        );
        if (!accelClose) {
          this.adjustAcceleration(workingConfig, measuredZero.timeSec, targets.zeroToHundredSec);
        }
      }
      let topClose = true;
      if (hasTopSpeed) {
        measuredTop = this.measureTopSpeed(workingConfig, { deadlineMs: deadline });
        topClose = this.isWithinTolerance(measuredTop.maxSpeedKph, targets.topSpeedKph, 0.03);
        if (!topClose) {
          this.adjustTopSpeed(workingConfig, measuredTop.maxSpeedKph, targets.topSpeedKph);
        }
      }
      if (accelClose && topClose) {
        break;
      }
    }

    // Final, more-detailed measurements (collect samples) but respect deadline
    if (hasZeroToHundred) {
      measuredZero = this.measureZeroToHundred(workingConfig, {
        collectSamples: zeroSamples,
        deadlineMs: deadline
      });
    }
    if (hasTopSpeed) {
      measuredTop = this.measureTopSpeed(workingConfig, {
        collectSamples: topSamples,
        deadlineMs: deadline
      });
    }

    const overrides = this.computeOverrides(workingConfig, baseConfig);

    return {
      version: this.version,
      verified: timedOut ? false : true,
      overrides,
      calibratedConfig: cloneCarConfig(workingConfig),
      samples: {
        zeroToHundred: zeroSamples,
        topSpeed: topSamples
      },
      measured: {
        zeroToHundredSec: measuredZero.timeSec,
        zeroToHundredReached: measuredZero.reached,
        topSpeedKph: measuredTop.maxSpeedKph,
        topSpeedDurationSec: measuredTop.durationSec
      },
      target: targets,
      iterations: actualIterations,
      updatedAt: Date.now(),
      note: timedOut ? `Calibration timed out after ${timeoutMs} ms` : undefined
    };
  }

  extractTargets(spec = {}) {
    const topSpeedKph =
      this.findNumeric(spec, ["topSpeedKph", "topSpeedKmH", "topSpeed", "vMaxKph", "vMaxKmH"]) ??
      (() => {
        const mph = this.findNumeric(spec, ["topSpeedMph", "topSpeedMPH"]);
        return Number.isFinite(mph) ? mph * 1.60934 : null;
      })();

    const zeroToHundred =
      this.findNumeric(spec, [
        "zeroToHundredSec",
        "zeroTo100Sec",
        "zeroToHundred",
        "zeroTo100",
        "zeroToHundredKmH"
      ]) ??
      (() => {
        const sixty = this.findNumeric(spec, [
          "zeroToSixtySec",
          "zeroToSixty",
          "zeroTo60Sec",
          "zeroTo60",
          "zeroToSixtyMph"
        ]);
        return Number.isFinite(sixty) ? sixty * 1.05 : null;
      })();

    if (!Number.isFinite(topSpeedKph) && !Number.isFinite(zeroToHundred)) {
      return null;
    }

    return {
      topSpeedKph: Number.isFinite(topSpeedKph) ? topSpeedKph : null,
      zeroToHundredSec: Number.isFinite(zeroToHundred) ? zeroToHundred : null
    };
  }

  findNumeric(spec, keys) {
    if (!spec || typeof spec !== "object") {
      return null;
    }
    const containers = [spec, spec.performance, spec.realWorld, spec.stats];
    for (const key of keys) {
      for (const container of containers) {
        if (!container || typeof container !== "object") {
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(container, key)) {
          continue;
        }
        const value = container[key];
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          return num;
        }
      }
    }
    return null;
  }

  measureZeroToHundred(config, options = {}) {
    const samples = Array.isArray(options.collectSamples) ? options.collectSamples : null;
    const sampleInterval = Number.isFinite(options.sampleInterval) ? options.sampleInterval : 0.02;
    const car = this.createTestCar(config);
    car.resetState({ position: { x: 0, y: 0 }, heading: 0 });
    if (samples) {
      samples.length = 0;
      samples.push({
        timeSec: 0,
        speedKph: 0,
        distanceM: 0,
        phase: "zeroToHundred"
      });
    }
    const dt = 1 / 200;
    const maxTime = 15;
    const deadlineMs = Number.isFinite(options.deadlineMs) ? Number(options.deadlineMs) : null;
    let time = 0;
    let previousSpeed = 0;
    let sampleTimer = 0;
    while (time < maxTime) {
      if (deadlineMs !== null && Date.now() > deadlineMs) {
        // Abort measurement early due to deadline
        if (samples) {
          const position = car.getWorldPosition();
          samples.push({
            timeSec: time,
            speedKph: car.getSpeedMetersPerSecond() * 3.6,
            distanceM: position.x / PIXELS_PER_METER,
            phase: "zeroToHundred",
            aborted: true
          });
        }
        return {
          timeSec: null,
          reached: false
        };
      }
      car.update(1, 0, 0, dt);
      time += dt;
      sampleTimer += dt;
      const speed = car.getSpeedMetersPerSecond() * 3.6;
      if (samples && sampleTimer >= sampleInterval) {
        sampleTimer = 0;
        const position = car.getWorldPosition();
        samples.push({
          timeSec: time,
          speedKph: speed,
          distanceM: position.x / PIXELS_PER_METER,
          phase: "zeroToHundred"
        });
      }
      if (speed >= 100) {
        const deltaSpeed = speed - previousSpeed;
        let crossingTime = time;
        if (deltaSpeed > 1e-6) {
          const ratio = clampToRange((100 - previousSpeed) / deltaSpeed, 0, 1);
          crossingTime = time - dt + ratio * dt;
        }
        if (samples) {
          const position = car.getWorldPosition();
          samples.push({
            timeSec: crossingTime,
            speedKph: speed,
            distanceM: position.x / PIXELS_PER_METER,
            phase: "zeroToHundred"
          });
        }
        return {
          timeSec: crossingTime,
          reached: true
        };
      }
      previousSpeed = speed;
    }
    if (samples) {
      const position = car.getWorldPosition();
      samples.push({
        timeSec: time,
        speedKph: car.getSpeedMetersPerSecond() * 3.6,
        distanceM: position.x / PIXELS_PER_METER,
        phase: "zeroToHundred"
      });
    }
    return {
      timeSec: maxTime,
      reached: false
    };
  }

  measureTopSpeed(config, options = {}) {
    const samples = Array.isArray(options.collectSamples) ? options.collectSamples : null;
    const sampleInterval = Number.isFinite(options.sampleInterval) ? options.sampleInterval : 0.04;
    const car = this.createTestCar(config);
    car.resetState({ position: { x: 0, y: 0 }, heading: 0 });
    if (samples) {
      samples.length = 0;
      samples.push({
        timeSec: 0,
        speedKph: 0,
        distanceM: 0,
        phase: "topSpeed"
      });
    }
    const dt = 1 / 200;
    const maxDuration = 160;
    const settleThreshold = 7;
    const deadlineMs = Number.isFinite(options.deadlineMs) ? Number(options.deadlineMs) : null;
    let time = 0;
    let maxSpeed = 0;
    let stableTime = 0;
    let sampleTimer = 0;
    while (time < maxDuration) {
      if (deadlineMs !== null && Date.now() > deadlineMs) {
        // Abort measurement early due to deadline
        if (samples) {
          const position = car.getWorldPosition();
          samples.push({
            timeSec: time,
            speedKph: car.getSpeedMetersPerSecond() * 3.6,
            distanceM: position.x / PIXELS_PER_METER,
            phase: "topSpeed",
            aborted: true
          });
        }
        return {
          maxSpeedKph: maxSpeed,
          durationSec: time
        };
      }
      car.update(1, 0, 0, dt);
      time += dt;
      sampleTimer += dt;
      const speed = car.getSpeedMetersPerSecond() * 3.6;
      if (samples && sampleTimer >= sampleInterval) {
        sampleTimer = 0;
        const position = car.getWorldPosition();
        samples.push({
          timeSec: time,
          speedKph: speed,
          distanceM: position.x / PIXELS_PER_METER,
          phase: "topSpeed"
        });
      }
      if (speed > maxSpeed + 0.05) {
        maxSpeed = speed;
        stableTime = 0;
      } else if (Math.abs(speed - maxSpeed) < 0.1) {
        stableTime += dt;
      } else {
        stableTime += dt * 0.25;
      }
      if (time > 5 && stableTime >= settleThreshold) {
        break;
      }
    }
    if (samples) {
      const position = car.getWorldPosition();
      samples.push({
        timeSec: time,
        speedKph: car.getSpeedMetersPerSecond() * 3.6,
        distanceM: position.x / PIXELS_PER_METER,
        phase: "topSpeed"
      });
    }
    return {
      maxSpeedKph: maxSpeed,
      durationSec: time
    };
  }

  adjustAcceleration(config, measuredSec, targetSec) {
    if (
      !Number.isFinite(measuredSec) ||
      !Number.isFinite(targetSec) ||
      measuredSec <= 0 ||
      targetSec <= 0
    ) {
      return;
    }
    const ratio = clampToRange(measuredSec / targetSec, 0.25, 4);
    const desiredEfficiency = clampToRange(
      (config.drivetrainEfficiency ?? defaultCarConfig().drivetrainEfficiency) /
        Math.pow(ratio, 0.92),
      0.6,
      1
    );
    config.drivetrainEfficiency = this.mix(
      config.drivetrainEfficiency ?? desiredEfficiency,
      desiredEfficiency,
      0.55
    );

    const desiredRolling = clampToRange(
      (config.rollingResistanceCoeff ?? defaultCarConfig().rollingResistanceCoeff) *
        (1 + (ratio - 1) * 0.45),
      0.0045,
      0.03
    );
    config.rollingResistanceCoeff = this.mix(
      config.rollingResistanceCoeff ?? desiredRolling,
      desiredRolling,
      0.35
    );
  }

  adjustTopSpeed(config, measuredKph, targetKph) {
    if (
      !Number.isFinite(measuredKph) ||
      !Number.isFinite(targetKph) ||
      measuredKph <= 0 ||
      targetKph <= 0
    ) {
      return;
    }
    const ratio = clampToRange(measuredKph / targetKph, 0.5, 1.6);
    const desiredDrag = clampToRange(
      (config.dragCoefficient ?? defaultCarConfig().dragCoefficient) * ratio * ratio,
      0.16,
      0.9
    );
    config.dragCoefficient = this.mix(
      config.dragCoefficient ?? desiredDrag,
      desiredDrag,
      0.6
    );

    const desiredEfficiency = clampToRange(
      (config.drivetrainEfficiency ?? defaultCarConfig().drivetrainEfficiency) /
        Math.pow(ratio, 0.35),
      0.6,
      1
    );
    config.drivetrainEfficiency = this.mix(
      config.drivetrainEfficiency ?? desiredEfficiency,
      desiredEfficiency,
      0.25
    );

    const desiredRolling = clampToRange(
      (config.rollingResistanceCoeff ?? defaultCarConfig().rollingResistanceCoeff) *
        (1 + (ratio - 1) * 0.25),
      0.0045,
      0.03
    );
    config.rollingResistanceCoeff = this.mix(
      config.rollingResistanceCoeff ?? desiredRolling,
      desiredRolling,
      0.2
    );
  }

  isWithinTolerance(current, target, toleranceFraction) {
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(target) ||
      !Number.isFinite(toleranceFraction) ||
      target === 0
    ) {
      return false;
    }
    const normalized = Math.abs(current - target) / Math.abs(target);
    return normalized <= Math.abs(toleranceFraction);
  }

  mix(current, target, factor) {
    const alpha = clampToRange(Number.isFinite(factor) ? factor : 0.5, 0, 1);
    const currentValue = Number.isFinite(current) ? current : target;
    return currentValue * (1 - alpha) + target * alpha;
  }

  computeOverrides(config, baseConfig) {
    const keys = ["dragCoefficient", "rollingResistanceCoeff", "drivetrainEfficiency"];
    const overrides = {};
    let changed = false;
    for (const key of keys) {
      const nextValue = config[key];
      if (!Number.isFinite(nextValue)) {
        continue;
      }
      const baseValue = baseConfig[key];
      if (Number.isFinite(baseValue) && Math.abs(nextValue - baseValue) <= 1e-4) {
        continue;
      }
      overrides[key] = Number(nextValue.toFixed(5));
      config[key] = overrides[key];
      changed = true;
    }
    return changed ? overrides : null;
  }

  persist() {
    if (!this.supportsStorage()) {
      return;
    }
    const payload = {};
    for (const [carId, record] of this.records.entries()) {
      payload[carId] = record;
    }
    try {
      globalThis.localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch (error) {
      this.logger?.warn?.("Failed to persist car verification data:", error);
    }
  }

  createTestCar(config) {
    // Verification runs inside a blank environment with no obstacles to ensure
    // consistent measurements of straight-line performance.
    return new PhysicsCar(config, {
      pixelsPerMeter: PIXELS_PER_METER,
      position: { x: 0, y: 0 },
      heading: 0
    });
  }
}

carVerificationManager = new CarVerificationManager();

class CalibrationVisualizer {
  constructor(canvas, context, assets) {
    this.canvas = canvas;
    this.ctx = context;
    this.assets = assets;
    this.active = false;
    this.padding = 96;
    this.backgroundColor = "#050914";
    this.trackColor = "#1e293b";
    this.progressTrackColor = "rgba(148, 163, 184, 0.35)";
    this.progressFillColor = "#38bdf8";
    this.textColor = "#e2e8f0";
    this.secondaryTextColor = "#94a3b8";
    this.spriteScale = 96;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  async play({ car, record, calibratedConfig }) {
    if (!car || !record) {
      return;
    }
    const samples = record.samples ?? {};
    const zeroSamples = Array.isArray(samples.zeroToHundred) ? samples.zeroToHundred : [];
    const topSamples = Array.isArray(samples.topSpeed) ? samples.topSpeed : [];
    const carLabel = formatCarLabel(car) || "Unknown vehicle";
    const spriteKey = chooseCarSprite(car);
    const sprite =
      this.assets[spriteKey] ||
      this.assets.car_default ||
      this.assets.player ||
      null;

    this.active = true;

    const zeroTarget = Number.isFinite(record.target?.zeroToHundredSec)
      ? record.target.zeroToHundredSec
      : null;
    const zeroActual = Number.isFinite(record.measured?.zeroToHundredSec)
      ? record.measured.zeroToHundredSec
      : null;
    const topTarget = Number.isFinite(record.target?.topSpeedKph)
      ? record.target.topSpeedKph
      : null;
    const topActual = Number.isFinite(record.measured?.topSpeedKph)
      ? record.measured.topSpeedKph
      : null;

    if (zeroSamples.length > 0) {
      const zeroSubtitleParts = [];
      if (zeroTarget != null) zeroSubtitleParts.push(`Target ${zeroTarget.toFixed(2)}s`);
      if (zeroActual != null) zeroSubtitleParts.push(`Result ${zeroActual.toFixed(2)}s`);
      await this.playPhase(zeroSamples, {
        title: `${carLabel} · 0-100 km/h`,
        subtitle: zeroSubtitleParts.join("  •  "),
        sprite,
        highlightSpeed: true
      });
      await this.wait(350);
    }

    if (topSamples.length > 0) {
      const topSubtitleParts = [];
      if (topTarget != null) topSubtitleParts.push(`Target ${topTarget.toFixed(1)} km/h`);
      if (topActual != null) topSubtitleParts.push(`Result ${topActual.toFixed(1)} km/h`);
      await this.playPhase(topSamples, {
        title: `${carLabel} · Top Speed`,
        subtitle: topSubtitleParts.join("  •  "),
        sprite,
        highlightSpeed: true
      });
      await this.wait(350);
    }

    await this.showSummary(carLabel, record, calibratedConfig);
    this.clear();
    this.active = false;
  }

  async playPhase(samples, options = {}) {
    if (!samples || samples.length === 0) {
      return;
    }
    const totalTime = samples[samples.length - 1].timeSec || 1;
    const playbackMs = Math.max(1600, Math.min(6000, totalTime * 1000 * 0.45));
    const maxDistance = samples.reduce(
      (max, sample) => Math.max(max, Number.isFinite(sample.distanceM) ? sample.distanceM : max),
      0
    );
    const usableWidth = Math.max(120, this.canvas.width - this.padding * 2);
    const distanceScale = maxDistance > 0 ? usableWidth / maxDistance : 1;
    const sprite = options.sprite ?? null;
    const title = options.title ?? "";
    const subtitle = options.subtitle ?? "";
    const start = await this.nextFrame();

    return new Promise((resolve) => {
      const step = (timestamp) => {
        if (!this.active) {
          resolve();
          return;
        }
        const elapsed = timestamp - start;
        const progress = clampToRange(elapsed / playbackMs, 0, 1);
        const targetTime = progress * totalTime;
        const sample = this.sampleAtTime(samples, targetTime);
        this.drawFrame({
          sample,
          samples,
          sprite,
          progress,
          title,
          subtitle,
          distanceScale,
          maxDistance
        });
        if (progress >= 1) {
          setTimeout(resolve, 200);
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
  }

  drawFrame({
    sample,
    sprite,
    progress,
    title,
    subtitle,
    distanceScale,
    maxDistance
  }) {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.save();
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    const trackY = height * 0.6;
    const trackStart = this.padding;
    const trackEnd = width - this.padding;

    ctx.strokeStyle = this.trackColor;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trackStart, trackY);
    ctx.lineTo(trackEnd, trackY);
    ctx.stroke();

    let distanceM = Number.isFinite(sample?.distanceM) ? sample.distanceM : 0;
    distanceM = clampToRange(distanceM, 0, Math.max(maxDistance, 1));
    const carX = trackStart + distanceM * distanceScale;
    const carY = trackY;

    if (sprite instanceof HTMLImageElement) {
      const renderWidth = this.spriteScale;
      const aspect = sprite.width > 0 ? sprite.height / sprite.width : 0.5;
      const renderHeight = renderWidth * aspect;
      ctx.drawImage(
        sprite,
        carX - renderWidth / 2,
        carY - renderHeight / 2,
        renderWidth,
        renderHeight
      );
    } else {
      ctx.fillStyle = "#f97316";
      ctx.fillRect(carX - 20, carY - 10, 40, 20);
    }

    ctx.fillStyle = this.textColor;
    ctx.font = "700 28px 'Segoe UI', sans-serif";
    ctx.fillText(title, this.padding, 64);
    ctx.font = "400 18px 'Segoe UI', sans-serif";
    ctx.fillStyle = this.secondaryTextColor;
    if (subtitle) {
      ctx.fillText(subtitle, this.padding, 96);
    }

    const speedText =
      sample && Number.isFinite(sample.speedKph) ? `${sample.speedKph.toFixed(1)} km/h` : "– km/h";
    ctx.font = "600 34px 'Segoe UI', sans-serif";
    ctx.fillStyle = this.textColor;
    ctx.fillText(speedText, this.padding, height * 0.42);

    const timeText =
      sample && Number.isFinite(sample.timeSec) ? `${sample.timeSec.toFixed(2)} s` : "– s";
    ctx.font = "500 20px 'Segoe UI', sans-serif";
    ctx.fillStyle = this.secondaryTextColor;
    ctx.fillText(timeText, this.padding, height * 0.47);

    const barWidth = width - this.padding * 2;
    const barHeight = 10;
    const barY = height - 80;
    ctx.fillStyle = this.progressTrackColor;
    ctx.fillRect(this.padding, barY, barWidth, barHeight);
    ctx.fillStyle = this.progressFillColor;
    ctx.fillRect(this.padding, barY, barWidth * clampToRange(progress, 0, 1), barHeight);

    ctx.restore();
  }

  async showSummary(carLabel, record, calibratedConfig) {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    const zeroActual = Number.isFinite(record.measured?.zeroToHundredSec)
      ? record.measured.zeroToHundredSec.toFixed(2)
      : "–";
    const zeroTarget = Number.isFinite(record.target?.zeroToHundredSec)
      ? record.target.zeroToHundredSec.toFixed(2)
      : "–";
    const topActual = Number.isFinite(record.measured?.topSpeedKph)
      ? record.measured.topSpeedKph.toFixed(1)
      : "–";
    const topTarget = Number.isFinite(record.target?.topSpeedKph)
      ? record.target.topSpeedKph.toFixed(1)
      : "–";

    const drivetrain = Number.isFinite(calibratedConfig?.drivetrainEfficiency)
      ? (calibratedConfig.drivetrainEfficiency * 100).toFixed(1)
      : "–";
    const drag = Number.isFinite(calibratedConfig?.dragCoefficient)
      ? calibratedConfig.dragCoefficient.toFixed(3)
      : "–";
    const rolling = Number.isFinite(calibratedConfig?.rollingResistanceCoeff)
      ? calibratedConfig.rollingResistanceCoeff.toFixed(3)
      : "–";

    ctx.save();
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = this.textColor;
    ctx.font = "700 30px 'Segoe UI', sans-serif";
    ctx.fillText(`${carLabel} calibrated`, this.padding, 120);

    ctx.font = "500 20px 'Segoe UI', sans-serif";
    ctx.fillStyle = this.secondaryTextColor;
    ctx.fillText(`0-100 km/h  Target ${zeroTarget} s   Result ${zeroActual} s`, this.padding, 170);
    ctx.fillText(`Top Speed   Target ${topTarget} km/h   Result ${topActual} km/h`, this.padding, 202);

    ctx.fillStyle = this.textColor;
    ctx.font = "600 22px 'Segoe UI', sans-serif";
    ctx.fillText("Applied tuning", this.padding, 260);
    ctx.font = "500 20px 'Segoe UI', sans-serif";
    ctx.fillStyle = this.secondaryTextColor;
    ctx.fillText(`Drag Coefficient  ${drag}`, this.padding, 298);
    ctx.fillText(`Drivetrain Efficiency  ${drivetrain}%`, this.padding, 330);
    ctx.fillText(`Rolling Resistance  ${rolling}`, this.padding, 362);

    ctx.restore();
    await this.wait(900);
  }

  sampleAtTime(samples, targetTime) {
    if (!samples || samples.length === 0) {
      return null;
    }
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample || !Number.isFinite(sample.timeSec)) {
        continue;
      }
      if (sample.timeSec >= targetTime) {
        return sample;
      }
    }
    return samples[samples.length - 1];
  }

  wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  }
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function formatNumber(value, decimals = 0) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "-";
}

function formatWithUnit(value, unit, decimals = 0) {
  return Number.isFinite(value) ? `${value.toFixed(decimals)} ${unit}` : "-";
}

function formatPercent(value, decimals = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : "-";
}

function formatGearRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length <= 1) {
    return "-";
  }
  return ratios
    .slice(1)
    .map((ratio, index) => `${index + 1}: ${ratio.toFixed(2)}`)
    .join("\n");
}

function formatSourcesList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "-";
  }
  return list.join("\n");
}

function formatGripPair(longitudinal, lateral) {
  const longText = Number.isFinite(longitudinal) ? longitudinal.toFixed(2) : "-";
  const latText = Number.isFinite(lateral) ? lateral.toFixed(2) : "-";
  if (!Number.isFinite(longitudinal) && !Number.isFinite(lateral)) {
    return "-";
  }
  return `${longText} / ${latText}`;
}

function buildSpecDisplay(config, carSpec) {
  if (!config) {
    return {};
  }
  const gearRatios = Array.isArray(config.gearRatios) ? config.gearRatios.slice() : null;
  const tireGripsLong = Array.isArray(config.tireGrips) ? config.tireGrips.slice() : [];
  const tireGripsLat =
    Array.isArray(config.tireLateralGrips) && config.tireLateralGrips.length >= 4
      ? config.tireLateralGrips.slice(0, 4)
      : tireGripsLong.map((value) => {
          const factor = Number.isFinite(config.tireLateralGripFactor)
            ? config.tireLateralGripFactor
            : 1.12;
          return value * factor;
        });
  const brakeTorquePerWheel = Array.isArray(config.brakeTorquePerWheelNm)
    ? config.brakeTorquePerWheelNm.slice(0, 4)
    : null;
  const frontBrakeTorque = brakeTorquePerWheel
    ? average(brakeTorquePerWheel.slice(0, 2))
    : null;
  const rearBrakeTorque = brakeTorquePerWheel
    ? average(brakeTorquePerWheel.slice(2, 4))
    : null;
  const frontGripsLong = tireGripsLong.slice(0, 2);
  const rearGripsLong = tireGripsLong.slice(2);
  const frontGripsLat = tireGripsLat.slice(0, 2);
  const rearGripsLat = tireGripsLat.slice(2);
  return {
    carLabel: formatCarLabel(carSpec),
    powerHp: config.horsepower ?? null,
    torqueNm: config.peakTorqueNm ?? null,
    driveType: config.driveType ?? null,
    massKg: config.massKg ?? null,
    revLimiterRpm: config.revLimiterRpm ?? null,
    brakeHorsepower: config.brakeHorsepower ?? null,
    finalDrive: config.finalDriveRatio ?? null,
    gearRatios,
    gearCount: Array.isArray(gearRatios) ? Math.max(gearRatios.length - 1, 0) : null,
    dragCoefficient: config.dragCoefficient ?? null,
    downforceCoefficient: config.downforceCoefficient ?? null,
    frontalAreaM2: config.frontalAreaM2 ?? null,
    wheelbaseM: config.wheelbaseM ?? null,
    trackWidthM: config.trackWidthM ?? null,
    cgHeightM: config.cgHeightM ?? null,
    frontWeightDistribution: config.frontWeightDistribution ?? null,
    wheelRadiusM: config.wheelRadiusM ?? null,
    tireGripFrontLong: average(frontGripsLong),
    tireGripRearLong: average(rearGripsLong),
    tireGripFrontLat: average(frontGripsLat),
    tireGripRearLat: average(rearGripsLat),
    brakeTorqueFrontNm: frontBrakeTorque,
    brakeTorqueRearNm: rearBrakeTorque,
    brakeTorquePerWheelNm: brakeTorquePerWheel,
    brakeBiasFront: config.brakeBiasFront ?? null,
    tireGripLongArray: tireGripsLong,
    tireGripLatArray: tireGripsLat,
    drivetrainEfficiency: config.drivetrainEfficiency ?? null,
    rollingResistanceCoeff: config.rollingResistanceCoeff ?? null,
    sources: Array.isArray(carSpec?.sources) ? carSpec.sources.slice() : null,
    year: carSpec?.year ?? null,
    country: carSpec?.country ?? null
  };
}

class InputManager {
  constructor() {
    this.state = {
      forward: false,
      reverse: false,
      left: false,
      right: false,
      brake: false
    };
    this.resetRequested = false;
    this.interactRequested = false;
    this.shiftUpRequested = false;
    this.shiftDownRequested = false;
    this.toggleTransmissionRequested = false;
    this.pauseToggleRequested = false;
    this.timeTrialMenuRequested = false;
    this.raceMenuRequested = false;
    this.handleKey = this.handleKey.bind(this);
    window.addEventListener("keydown", this.handleKey, { passive: false });
    window.addEventListener("keyup", this.handleKey, { passive: false });
  }

  handleKey(event) {
    const pressed = event.type === "keydown";
    const handled = this.updateState(event.code, pressed);
    if (handled) {
      event.preventDefault();
    }
  }

  updateState(code, pressed) {
    switch (code) {
      case "ArrowUp":
      case "KeyW":
        this.state.forward = pressed;
        return true;
      case "ArrowDown":
      case "KeyS":
        this.state.reverse = pressed;
        return true;
      case "ArrowLeft":
      case "KeyA":
        this.state.left = pressed;
        return true;
      case "ArrowRight":
      case "KeyD":
        this.state.right = pressed;
        return true;
      case "Space":
        this.state.brake = pressed;
        return true;
      case "KeyX":
        if (pressed) {
          this.shiftUpRequested = true;
        }
        return true;
      case "KeyZ":
        if (pressed) {
          this.shiftDownRequested = true;
        }
        return true;
      case "KeyM":
        if (pressed) {
          this.toggleTransmissionRequested = true;
        }
        return true;
      case "KeyE":
        if (pressed) {
          this.interactRequested = true;
        }
        return true;
      case "KeyR":
        if (pressed) {
          this.resetRequested = true;
        }
        return true;
      case "Escape":
        if (pressed) {
          this.pauseToggleRequested = true;
        }
        return true;
      case "Digit1":
      case "Numpad1":
        if (pressed) {
          this.timeTrialMenuRequested = true;
        }
        return true;
      case "Digit2":
      case "Numpad2":
        if (pressed) {
          this.raceMenuRequested = true;
        }
        return true;
      default:
        return false;
    }
  }

  consumeReset() {
    if (!this.resetRequested) {
      return false;
    }

    this.resetRequested = false;
    return true;
  }

  consumeInteract() {
    if (!this.interactRequested) {
      return false;
    }

    this.interactRequested = false;
    return true;
  }

  consumeShiftUp() {
    if (!this.shiftUpRequested) {
      return false;
    }
    this.shiftUpRequested = false;
    return true;
  }

  consumeShiftDown() {
    if (!this.shiftDownRequested) {
      return false;
    }
    this.shiftDownRequested = false;
    return true;
  }

  consumeToggleTransmission() {
    if (!this.toggleTransmissionRequested) {
      return false;
    }
    this.toggleTransmissionRequested = false;
    return true;
  }

  consumeTimeTrialMenu() {
    if (!this.timeTrialMenuRequested) {
      return false;
    }
    this.timeTrialMenuRequested = false;
    return true;
  }

  consumeRaceMenu() {
    if (!this.raceMenuRequested) {
      return false;
    }
    this.raceMenuRequested = false;
    return true;
  }

  consumePauseToggle() {
    if (!this.pauseToggleRequested) {
      return false;
    }
    this.pauseToggleRequested = false;
    return true;
  }

  clearMovementState() {
    this.state.forward = false;
    this.state.reverse = false;
    this.state.left = false;
    this.state.right = false;
    this.state.brake = false;
    this.resetRequested = false;
    this.interactRequested = false;
    this.shiftUpRequested = false;
    this.shiftDownRequested = false;
    this.toggleTransmissionRequested = false;
    this.pauseToggleRequested = false;
    this.timeTrialMenuRequested = false;
    this.raceMenuRequested = false;
  }
}

class Level {
  constructor(tileset, system) {
    this.tileset = tileset;
    this.system = system;
    this.tileCache = new Map();
    this.solidBodies = new Map();
    this.roadTiles = new Map();
    this.buildingTiles = new Set();
    this.horizontalRows = new Set();
    this.verticalColumns = new Set();
    this.roadBuildingCounts = new Map();
    this.roadTileSpawnCounter = 0;
    this.nodes = new Map();
    this.cellNodes = new Map();
    this.generatedCells = new Set();
    this.generatedChunks = new Set();
    this.generatedEdges = new Set();
    this.pixelWidth = Infinity;
    this.pixelHeight = Infinity;
    this.bounds = {
      minX: -Infinity,
      minY: -Infinity,
      maxX: Infinity,
      maxY: Infinity
    };
    this.startPose = {
      x: TILE_SIZE / 2,
      y: TILE_SIZE / 2,
      angle: 0
    };
    this.createRootNode();
    this.initializeStarterRoads();
    this.removeBuildingsOnRoadTiles();
    this.pendingTrafficSegments = [];
    if (!Array.isArray(globalThis.__pendingTrafficSegments)) {
      globalThis.__pendingTrafficSegments = [];
    }
    this.roadKeyList = [];
    this.rowTileMap = new Map();
    this.columnTileMap = new Map();
    this.pendingTrafficTiles = [];
    if (!Array.isArray(globalThis.__pendingTrafficTiles)) {
      globalThis.__pendingTrafficTiles = [];
    }
    this.chunkGenerationDepth = 0;
    this.markingRoadTileDepth = 0;
    this.timeTrialEvents = [];
    this.chunkTimeTrials = new Map();
    this.timeTrialIdCounter = 1;
    this.aiRaceIdCounter = 1;
  }

  tileKey(x, y) {
    return `${x},${y}`;
  }

  cellKey(cx, cy) {
    return `${cx},${cy}`;
  }

  createRootNode() {
    const node = {
      key: "0,0,root",
      cx: 0,
      cy: 0,
      index: 0,
      x: 0,
      y: 0,
      priority: 0,
      zone: getZone(0, 0),
      parentKey: null
    };
    this.nodes.set(node.key, node);
    this.addNodeToCell(node);
    this.markRoadTile(node.x, node.y, null);
    return node;
  }

  initializeStarterRoads() {
    const starterLength = 16;
    this.tracePath(0, 0, starterLength, 0);
    this.tracePath(0, 0, -starterLength, 0);
    this.tracePath(0, 0, 0, starterLength);
    this.tracePath(0, 0, 0, -starterLength);

  }


  addNodeToCell(node) {
    const key = this.cellKey(node.cx, node.cy);
    const nodes = this.cellNodes.get(key) || [];
    nodes.push(node);
    this.cellNodes.set(key, nodes);
  }

  ensureInfrastructure(x, y) {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        this.ensureCell(cx + dx, cy + dy);
      }
    }
  }

  ensureCell(cx, cy) {
    const key = this.cellKey(cx, cy);
    if (this.generatedCells.has(key)) {
      return;
    }
    this.generatedCells.add(key);

    const zone = getZone(cx * CELL_SIZE, cy * CELL_SIZE);
    const baseHash = hashCoordinates(cx * 374761393, cy * 668265263);
    const desiredNodes =
      zone === "city"
        ? 3 + (baseHash & 0x3)
        : (baseHash & 0x7) === 0
          ? 1
          : 0;

    for (let slot = 0; slot < desiredNodes; slot += 1) {
      this.ensureNode(cx, cy, slot, zone);
    }
  }

  ensureNode(cx, cy, slot, zone) {
    const nodeKey = `${cx},${cy},${slot}`;
    if (this.nodes.has(nodeKey)) {
      return this.nodes.get(nodeKey);
    }

    const seedX = cx * 91815541 + slot * 811;
    const seedY = cy * 137 + slot * 131;
    const baseHash = hashCoordinates(seedX, seedY);
    const offsetRange = zone === "city" ? CELL_SIZE / 4 : CELL_SIZE / 3;
    const ox = ((baseHash & 0xff) / 255 - 0.5) * 2 * offsetRange;
    const oy = (((baseHash >> 8) & 0xff) / 255 - 0.5) * 2 * offsetRange;
    let x = Math.round(cx * CELL_SIZE + CELL_SIZE / 2 + ox);
    let y = Math.round(cy * CELL_SIZE + CELL_SIZE / 2 + oy);

    const nearbyRow = this.findNearbyCoordinate(this.horizontalRows, y);
    if (nearbyRow !== null) {
      y = nearbyRow;
    } else {
      y = this.findClearCoordinate(this.horizontalRows, y);
    }
    const nearbyColumn = this.findNearbyCoordinate(this.verticalColumns, x);
    if (nearbyColumn !== null) {
      x = nearbyColumn;
    } else {
      x = this.findClearCoordinate(this.verticalColumns, x);
    }

    const node = {
      key: nodeKey,
      cx,
      cy,
      index: slot,
      x,
      y,
      priority: baseHash >>> 9,
      zone,
      parentKey: null
    };

    this.nodes.set(nodeKey, node);
    this.addNodeToCell(node);

    const root = this.nodes.get("0,0,root");
    if (node.key === root.key) {
      return node;
    }

    const candidateCells = [
      [cx - 1, cy],
      [cx, cy - 1],
      [cx - 1, cy - 1],
      [cx + 1, cy - 1],
      [cx - 1, cy + 1]
    ];

    const candidates = [];
    for (const [ncx, ncy] of candidateCells) {
      this.ensureCell(ncx, ncy);
      const list = this.cellNodes.get(this.cellKey(ncx, ncy));
      if (list) {
        candidates.push(...list);
      }
    }

    let parent = root;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      if (candidate.key === node.key) {
        continue;
      }
      if (candidate.priority > node.priority && candidate.key !== root.key) {
        continue;
      }
      const distance = Math.abs(candidate.x - node.x) + Math.abs(candidate.y - node.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        parent = candidate;
      }
    }

    node.parentKey = parent.key;
    this.connectNodes(node, parent);

    return node;
  }

  connectNodes(node, parent) {
    if (!parent) {
      return;
    }

    const edgeId = node.key < parent.key ? `${node.key}|${parent.key}` : `${parent.key}|${node.key}`;
    if (this.generatedEdges.has(edgeId)) {
      return;
    }
    this.generatedEdges.add(edgeId);

    const horizontalFirst = (hashCoordinates(node.x, parent.y) & 1) === 0;
    if (horizontalFirst) {
      if (!this.tracePath(node.x, node.y, parent.x, node.y)) {
        return;
      }
      if (!this.tracePath(parent.x, node.y, parent.x, parent.y)) {
        return;
      }
    } else {
      if (!this.tracePath(node.x, node.y, node.x, parent.y)) {
        return;
      }
      if (!this.tracePath(node.x, parent.y, parent.x, parent.y)) {
        return;
      }
    }
  }

  tracePath(fromX, fromY, toX, toY) {
    if (!this.previewPath(fromX, fromY, toX, toY)) {
      return false;
    }

    let x = fromX;
    let y = fromY;

    if (x === toX && y === toY) {
      this.markRoadTile(x, y, null);
      return true;
    }

    while (x !== toX) {
      const nextX = x + Math.sign(toX - x);
      if (!this.markRoadStep(x, y, nextX, y)) {
        return false;
      }
      x = nextX;
    }

    while (y !== toY) {
      const nextY = y + Math.sign(toY - y);
      if (!this.markRoadStep(x, y, x, nextY)) {
        return false;
      }
      y = nextY;
    }
    return true;
  }


  markRoadTile(x, y, direction) {
    this.markingRoadTileDepth = (this.markingRoadTileDepth || 0) + 1;
    const key = this.tileKey(x, y);
    this.removeBuildingAt(x, y);
    let entry = this.roadTiles.get(key);
    const created = !entry;
    if (!entry) {
      entry = { connections: new Set() };
      this.roadTiles.set(key, entry);
    }
    if (direction) {
      entry.connections.add(direction);
      this._ensureReciprocalRoadConnection(x, y, direction);
    }
    this.tileCache.delete(key);
    this.updateOrientationSets(x, y, entry);

    if (created) {
      if (!Array.isArray(this.roadKeyList)) {
        this.roadKeyList = [];
      }
      this.roadKeyList.push(key);
      this._recordRoadLineTile(x, y);
      this.roadTileSpawnCounter += 1;
      const zone = getZone(x * TILE_SIZE, y * TILE_SIZE);
      const spawnInterval = zone === "city" ? 2 : 4;
      if (this.roadTileSpawnCounter % spawnInterval === 0) {
      if (!Array.isArray(this.pendingTrafficTiles)) {
        this.pendingTrafficTiles = [];
      }
      this.pendingTrafficTiles.push({ tileX: x, tileY: y });
    }
  }
    this.markingRoadTileDepth -= 1;
    if (this.markingRoadTileDepth <= 0) {
      this.markingRoadTileDepth = 0;
      if ((this.chunkGenerationDepth || 0) === 0) {
        this.flushPendingTrafficTiles();
      }
    }
  }

  _ensureReciprocalRoadConnection(x, y, direction) {
    const delta = TRAFFIC_DIRECTIONS[direction];
    if (!delta) {
      return;
    }
    const neighborX = x + delta.dx;
    const neighborY = y + delta.dy;
    const neighborKey = this.tileKey(neighborX, neighborY);
    const neighborEntry = this.roadTiles.get(neighborKey);
    if (!neighborEntry) {
      return;
    }
    const opposite = this.oppositeDirection(direction);
    if (!neighborEntry.connections.has(opposite)) {
      neighborEntry.connections.add(opposite);
      this.tileCache.delete(neighborKey);
      this.updateOrientationSets(neighborX, neighborY, neighborEntry);
    }
  }

  _repairRoadConnectionsAt(x, y) {
    const key = this.tileKey(x, y);
    const entry = this.roadTiles.get(key);
    if (!entry) {
      return;
    }
    const neighbors = [
      { dir: "N", dx: 0, dy: -1, opposite: "S" },
      { dir: "S", dx: 0, dy: 1, opposite: "N" },
      { dir: "E", dx: 1, dy: 0, opposite: "W" },
      { dir: "W", dx: -1, dy: 0, opposite: "E" }
    ];
    let changed = false;
    for (const neighbor of neighbors) {
      const neighborEntry = this.roadTiles.get(this.tileKey(x + neighbor.dx, y + neighbor.dy));
      if (!neighborEntry) {
        continue;
      }
      if (neighborEntry.connections.has(neighbor.opposite) && !entry.connections.has(neighbor.dir)) {
        entry.connections.add(neighbor.dir);
        changed = true;
      }
    }
    if (changed) {
      this.tileCache.delete(key);
      this.updateOrientationSets(x, y, entry);
    }
  }

  _repairRoadConnectionsInBounds(minX, maxX, minY, maxY) {
    for (let ty = minY; ty <= maxY; ty += 1) {
      for (let tx = minX; tx <= maxX; tx += 1) {
        this._repairRoadConnectionsAt(tx, ty);
      }
    }
  }

  _recordRoadLineTile(x, y) {
    if (!this.rowTileMap) {
      this.rowTileMap = new Map();
    }
    if (!this.columnTileMap) {
      this.columnTileMap = new Map();
    }
    let rowSet = this.rowTileMap.get(y);
    if (!rowSet) {
      rowSet = new Set();
      this.rowTileMap.set(y, rowSet);
    }
    rowSet.add(x);

    let columnSet = this.columnTileMap.get(x);
    if (!columnSet) {
      columnSet = new Set();
      this.columnTileMap.set(x, columnSet);
    }
    columnSet.add(y);
  }

  markRoadStep(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    if (dx === 0 && dy === 0) {
      this.markRoadTile(fromX, fromY, null);
      return true;
    }

    const direction = this.directionFromDelta(dx, dy);
    const opposite = this.oppositeDirection(direction);
    if (!this.canPlaceSegment(fromX, fromY, toX, toY)) {
      return false;
    }
    this.markRoadTile(fromX, fromY, direction);
    this.markRoadTile(toX, toY, opposite);

    // Notify traffic spawner about the newly placed road segment.
    // If a TrafficManager is registered on the level, call it immediately.
    // Otherwise push to the global pending queue to be drained later.
    try {
      const request = { fromX, fromY, toX, toY };
      if (Array.isArray(this.pendingTrafficSegments)) {
        this.pendingTrafficSegments.push(request);
      } else if (Array.isArray(globalThis.__pendingTrafficSegments)) {
        globalThis.__pendingTrafficSegments.push(request);
      }
      if ((this.chunkGenerationDepth || 0) === 0) {
        this.flushPendingTrafficSegments();
      }
    } catch (_e) {
      // silent fail to avoid blocking level generation
    }

    return true;
  }

  flushPendingTrafficSegments() {
    const localQueue =
      this.pendingTrafficSegments && this.pendingTrafficSegments.length
        ? this.pendingTrafficSegments.splice(0)
        : [];
    let globalQueue = [];
    if (
      (!localQueue || localQueue.length === 0) &&
      globalThis &&
      Array.isArray(globalThis.__pendingTrafficSegments) &&
      globalThis.__pendingTrafficSegments.length > 0
    ) {
      globalQueue = globalThis.__pendingTrafficSegments.splice(0);
    }
    const segments = localQueue.length ? localQueue : globalQueue;
    if (!segments.length) {
      return;
    }
    for (const request of segments) {
      try {
        if (this.trafficManager && typeof this.trafficManager.spawnForRoadSegment === "function") {
          this.trafficManager.spawnForRoadSegment(request);
        } else if (globalThis.__pendingRoadSpawns) {
          globalThis.__pendingRoadSpawns.push(request);
        }
      } catch (_error) {
        if (globalThis.__pendingRoadSpawns) {
          globalThis.__pendingRoadSpawns.push(request);
        }
      }
    }
  }

  flushPendingTrafficTiles() {
    const localTiles =
      this.pendingTrafficTiles && this.pendingTrafficTiles.length
        ? this.pendingTrafficTiles.splice(0)
        : [];
    let globalTiles = [];
    if (
      (!localTiles || localTiles.length === 0) &&
      globalThis &&
      Array.isArray(globalThis.__pendingTrafficTiles) &&
      globalThis.__pendingTrafficTiles.length > 0
    ) {
      globalTiles = globalThis.__pendingTrafficTiles.splice(0);
    }
    const tiles = localTiles.length ? localTiles : globalTiles;
    if (!tiles.length) {
      return;
    }
    for (const tile of tiles) {
      try {
        if (this.trafficManager && typeof this.trafficManager.spawnAtRoadTile === "function") {
          this.trafficManager.spawnAtRoadTile(tile.tileX, tile.tileY);
        } else if (globalThis.__pendingTrafficTiles) {
          globalThis.__pendingTrafficTiles.push(tile);
        }
      } catch (_error) {
        if (globalThis.__pendingTrafficTiles) {
          globalThis.__pendingTrafficTiles.push(tile);
        }
      }
    }
  }

  updateOrientationSets(x, y, entry) {
    const hasHorizontal = entry.connections.has("E") || entry.connections.has("W");
    const hasVertical = entry.connections.has("N") || entry.connections.has("S");

    // When a row/column is first recognized as containing road tiles, notify traffic.
    if (hasHorizontal) {
      const wasPresent = this.horizontalRows.has(y);
      this.horizontalRows.add(y);
      if (!wasPresent) {
        try {
          if (this.trafficManager && typeof this.trafficManager.spawnForRoadLine === "function") {
            this.trafficManager.spawnForRoadLine("H", y);
          } else if (globalThis.__pendingRoadLineSpawns) {
            globalThis.__pendingRoadLineSpawns.push({ axis: "H", coord: y });
          } else if (globalThis.__pendingRoadSpawns) {
            // fallback to a segment-style request for compatibility (will be drained as segments)
            globalThis.__pendingRoadSpawns.push({ fromX: 0, fromY: y, toX: 1, toY: y });
          }
        } catch (_e) {}
      }
    }

    if (hasVertical) {
      const wasPresent = this.verticalColumns.has(x);
      this.verticalColumns.add(x);
      if (!wasPresent) {
        try {
          if (this.trafficManager && typeof this.trafficManager.spawnForRoadLine === "function") {
            this.trafficManager.spawnForRoadLine("V", x);
          } else if (globalThis.__pendingRoadLineSpawns) {
            globalThis.__pendingRoadLineSpawns.push({ axis: "V", coord: x });
          } else if (globalThis.__pendingRoadSpawns) {
            globalThis.__pendingRoadSpawns.push({ fromX: x, fromY: 0, toX: x, toY: 1 });
          }
        } catch (_e) {}
      }
    }
  }

  findNearbyCoordinate(set, value) {
    if (!set || set.size === 0) {
      return null;
    }
    let nearest = null;
    let bestDistance = Infinity;
    for (const coord of set) {
      const dist = Math.abs(coord - value);
      if (dist <= 1 && dist < bestDistance) {
        bestDistance = dist;
        nearest = coord;
      }
    }
    return nearest;
  }

  findClearCoordinate(set, value) {
    let candidate = Math.round(value);
    let attempt = 0;
    while (true) {
      let tooClose = false;
      for (const coord of set) {
        if (Math.abs(coord - candidate) <= 1) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        return candidate;
      }
      const direction = attempt % 2 === 0 ? 1 : -1;
      const step = ((attempt >> 1) + 1) * 2;
      candidate = Math.round(value + direction * step);
      attempt += 1;
      if (attempt > 16) {
        return candidate;
      }
    }
  }

  hasHorizontalRoadAt(x, y) {
    const entry = this.roadTiles.get(this.tileKey(x, y));
    if (!entry) {
      return false;
    }
    return entry.connections.has("E") || entry.connections.has("W");
  }

  hasVerticalRoadAt(x, y) {
    const entry = this.roadTiles.get(this.tileKey(x, y));
    if (!entry) {
      return false;
    }
    return entry.connections.has("N") || entry.connections.has("S");
  }

  canPlaceSegment(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    if (dx !== 0 && dy !== 0) {
      return false;
    }

    if (dy === 0) {
      const y = fromY;
      const above = y + 1;
      const below = y - 1;
      const xPositions = [fromX, toX];
      for (const x of xPositions) {
        if (this.hasHorizontalRoadAt(x, above) || this.hasHorizontalRoadAt(x, below)) {
          return false;
        }
      }
    } else {
      const x = fromX;
      const left = x - 1;
      const right = x + 1;
      const yPositions = [fromY, toY];
      for (const y of yPositions) {
        if (this.hasVerticalRoadAt(left, y) || this.hasVerticalRoadAt(right, y)) {
          return false;
        }
      }
    }

    return true;
  }

  previewPath(fromX, fromY, toX, toY) {
    let x = fromX;
    let y = fromY;
    if (x === toX && y === toY) {
      return true;
    }

    while (x !== toX) {
      const nextX = x + Math.sign(toX - x);
      if (!this.canPlaceSegment(x, y, nextX, y)) {
        return false;
      }
      x = nextX;
    }

    while (y !== toY) {
      const nextY = y + Math.sign(toY - y);
      if (!this.canPlaceSegment(x, y, x, nextY)) {
        return false;
      }
      y = nextY;
    }

    return true;
  }

  determineRoadTileCode(x, y, entry) {
    const hasVertical = entry.connections.has("N") || entry.connections.has("S");
    const hasHorizontal = entry.connections.has("E") || entry.connections.has("W");
    if (x === 0 && y === 0) {
      return "S";
    }
    if (hasVertical && hasHorizontal) {
      return "I";
    }
    if (hasVertical) {
      return "V";
    }
    return "R";
  }

  getAdjacentRoadKeys(x, y) {
    const keys = new Set();
    const neighbors = [
      { dx: 1, dy: 0, axis: "vertical" },
      { dx: -1, dy: 0, axis: "vertical" },
      { dx: 0, dy: 1, axis: "horizontal" },
      { dx: 0, dy: -1, axis: "horizontal" }
    ];

    for (const { dx, dy, axis } of neighbors) {
      const rx = x + dx;
      const ry = y + dy;
      const entry = this.roadTiles.get(this.tileKey(rx, ry));
      if (!entry) {
        continue;
      }

      const hasHorizontal = entry.connections.has("E") || entry.connections.has("W");
      const hasVertical = entry.connections.has("N") || entry.connections.has("S");

      if (axis === "horizontal" && hasHorizontal) {
        keys.add(`H:${ry}`);
      } else if (axis === "vertical" && hasVertical) {
        keys.add(`V:${rx}`);
      }
    }

    return Array.from(keys);
  }

  removeBuildingAt(x, y) {
    const key = this.tileKey(x, y);
    let hadBuilding = this.buildingTiles.has(key);
    if (!hadBuilding) {
      const cached = this.tileCache.get(key);
      if (cached && BUILDING_CODES.includes(cached.code)) {
        hadBuilding = true;
      }
    }
    if (!hadBuilding) {
      return;
    }

    this.buildingTiles.delete(key);

    const roadKeys = this.getAdjacentRoadKeys(x, y);
    for (const roadKey of roadKeys) {
      const current = this.roadBuildingCounts.get(roadKey) || 0;
      if (current <= 1) {
        this.roadBuildingCounts.delete(roadKey);
      } else {
        this.roadBuildingCounts.set(roadKey, current - 1);
      }
    }

    const body = this.solidBodies.get(key);
    if (body) {
      this.system.remove(body);
      this.solidBodies.delete(key);
    }

    if (this.tileCache.has(key)) {
      this.tileCache.delete(key);
    }
  }

  removeBuildingsOnRoadTiles() {
    for (const key of this.roadTiles.keys()) {
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const y = Number(yStr);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.removeBuildingAt(x, y);
      }
    }
  }

  selectBuildingCode(x, y, zone) {
    const code = chooseBuildingCode(x, y, zone);
    if (!code) {
      return null;
    }

    if (Math.abs(x) <= 2 && Math.abs(y) <= 2) {
      return null;
    }

    const roadKeys = this.getAdjacentRoadKeys(x, y);
    if (!roadKeys.length) {
      return null;
    }

    if (zone !== "city") {
      for (const key of roadKeys) {
        if ((this.roadBuildingCounts.get(key) || 0) >= 5) {
          return null;
        }
      }
    }

    for (const key of roadKeys) {
      this.roadBuildingCounts.set(key, (this.roadBuildingCounts.get(key) || 0) + 1);
    }

    return code;
  }

  findNearestRoad(x, y, minDistance = 0) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let fallback = null;
    let fallbackDistance = Number.POSITIVE_INFINITY;

    for (const key of this.roadTiles.keys()) {
      const [txStr, tyStr] = key.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      const distance = Math.abs(tx - x) + Math.abs(ty - y);

      if (distance > minDistance && distance < bestDistance) {
        bestDistance = distance;
        best = { x: tx, y: ty };
      }

      if (distance < fallbackDistance) {
        fallbackDistance = distance;
        fallback = { x: tx, y: ty };
      }
    }

    if (best) {
      return best;
    }

    if (fallback) {
      return fallback;
    }

    return { x: 0, y: 0 };
  }

  hasRoadInBounds(startX, endX, startY, endY) {
    for (const key of this.roadTiles.keys()) {
      const [txStr, tyStr] = key.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      if (tx >= startX && tx < endX && ty >= startY && ty < endY) {
        return true;
      }
    }
    return false;
  }

  countRoadTilesInBounds(startX, endX, startY, endY) {
    let count = 0;
    for (const key of this.roadTiles.keys()) {
      const [txStr, tyStr] = key.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      if (tx >= startX && tx < endX && ty >= startY && ty < endY) {
        count += 1;
      }
    }
    return count;
  }

  getRandomRoadKeys(count = 256) {
    if (!Array.isArray(this.roadKeyList) || this.roadKeyList.length === 0) {
      return [];
    }
    const limit = Math.min(count, this.roadKeyList.length);
    const selected = new Set();
    while (selected.size < limit) {
      const index = Math.floor(Math.random() * this.roadKeyList.length);
      selected.add(this.roadKeyList[index]);
    }
    return Array.from(selected);
  }

  getLineTiles(axis, coord) {
    if (axis === "H") {
      const set = this.rowTileMap.get(coord);
      if (!set || set.size === 0) {
        return [];
      }
      return Array.from(set).sort((a, b) => a - b).map((x) => ({ x, y: coord }));
    }
    if (axis === "V") {
      const set = this.columnTileMap.get(coord);
      if (!set || set.size === 0) {
        return [];
      }
      return Array.from(set).sort((a, b) => a - b).map((y) => ({ x: coord, y }));
    }
    return [];
  }

  _generateTimeTrialsForChunk(chunkX, chunkY) {
    const chunkKey = `${chunkX},${chunkY}`;
    if (this.chunkTimeTrials.has(chunkKey)) {
      return;
    }
    const startX = chunkX * ZONE_SIZE;
    const startY = chunkY * ZONE_SIZE;
    const endX = startX + ZONE_SIZE;
    const endY = startY + ZONE_SIZE;
    const candidates = this._collectRoadTilesInBounds(startX, endX, startY, endY);
    const trials = [];
    if (candidates.length === 0) {
      this.chunkTimeTrials.set(chunkKey, trials);
      return;
    }
    const attemptsLimit = TIME_TRIALS_PER_CITY_CHUNK * 12;
    let attempts = 0;
    while (trials.length < TIME_TRIALS_PER_CITY_CHUNK && attempts < attemptsLimit) {
      attempts += 1;
      const start = candidates[Math.floor(Math.random() * candidates.length)];
      if (!start) {
        break;
      }
      const track = this._buildTimeTrialTrack(start.x, start.y);
      if (!track) {
        continue;
      }
      track.id = this.timeTrialIdCounter++;
      track.chunkKey = chunkKey;
      trials.push(track);
      this.timeTrialEvents.push(track);
    }
    this.chunkTimeTrials.set(chunkKey, trials);
    this._generateAiRacesForChunk(chunkKey, trials);
  }

  _generateAiRacesForChunk(chunkKey, trials) {
    if (!Array.isArray(trials) || trials.length === 0) {
      return;
    }
    const perChunk = Math.min(AI_RACES_PER_CITY_CHUNK, trials.length);
    if (perChunk <= 0) {
      return;
    }
    const used = new Set();
    let attempts = 0;
    while (used.size < perChunk && attempts < trials.length * 2) {
      attempts += 1;
      const candidate = trials[Math.floor(Math.random() * trials.length)];
      if (!candidate || used.has(candidate)) {
        continue;
      }
      const race = this._createAiRaceDefinition(
        candidate.path.map((point) => ({ x: point.x, y: point.y })),
        AI_RACE_OPPONENT_COUNT
      );
      if (!race) {
        continue;
      }
      race.id = this.aiRaceIdCounter++;
      race.chunkKey = chunkKey;
      this.timeTrialEvents.push(race);
      used.add(candidate);
    }
  }

  _collectRoadTilesInBounds(startX, endX, startY, endY) {
    const tiles = [];
    for (const key of this.roadTiles.keys()) {
      const [txStr, tyStr] = key.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      if (
        Number.isFinite(tx) &&
        Number.isFinite(ty) &&
        tx >= startX &&
        tx < endX &&
        ty >= startY &&
        ty < endY
      ) {
        tiles.push({ x: tx, y: ty });
      }
    }
    return tiles;
  }

  _buildTimeTrialTrack(startX, startY) {
    const startKey = this.tileKey(startX, startY);
    if (!this.roadTiles.has(startKey)) {
      return null;
    }
    const visited = new Set([startKey]);
    const path = [{ x: startX, y: startY }];
    let current = { x: startX, y: startY };
    while (path.length < TIME_TRIAL_MAX_LENGTH) {
      const neighbors = this._availableRoadNeighbors(current.x, current.y, visited);
      if (!neighbors.length) {
        break;
      }
      const next = neighbors[Math.floor(Math.random() * neighbors.length)];
      current = { x: next.x, y: next.y };
      path.push(current);
      visited.add(this.tileKey(current.x, current.y));
      if (path.length >= TIME_TRIAL_MIN_LENGTH && Math.random() < 0.3) {
        break;
      }
    }
    if (path.length < TIME_TRIAL_MIN_LENGTH) {
      return null;
    }
    return this._createTimeTrialDefinition(path);
  }

  _availableRoadNeighbors(x, y, visited) {
    const entry = this.roadTiles.get(this.tileKey(x, y));
    if (!entry) {
      return [];
    }
    const neighbors = [];
    for (const dir of entry.connections) {
      const vec = TRAFFIC_DIRECTIONS[dir];
      if (!vec) {
        continue;
      }
      const nx = x + vec.dx;
      const ny = y + vec.dy;
      const key = this.tileKey(nx, ny);
      if (!this.roadTiles.has(key)) {
        continue;
      }
      if (visited && visited.has(key)) {
        continue;
      }
      neighbors.push({ x: nx, y: ny, dir });
    }
    return neighbors;
  }

  _createTimeTrialDefinition(path) {
    const series = this._buildCheckpointSeries(path);
    if (!series) {
      return null;
    }
    return {
      id: 0,
      chunkKey: null,
      path: path.map((point) => ({ x: point.x, y: point.y })),
      checkpoints: series.checkpoints,
      start: series.start,
      finish: series.finish,
      length: series.length,
      eventType: "timeTrial",
      isActive: false,
      isRunning: false,
      isCompleted: false,
      currentIndex: 0,
      elapsedTime: 0,
      leaderboard: []
    };
  }

  _createAiRaceDefinition(path, opponentCount = AI_RACE_OPPONENT_COUNT) {
    const series = this._buildCheckpointSeries(path);
    if (!series) {
      return null;
    }
    return {
      id: 0,
      chunkKey: null,
      path: path.map((point) => ({ x: point.x, y: point.y })),
      checkpoints: series.checkpoints,
      start: series.start,
      finish: series.finish,
      length: series.length,
      eventType: "aiRace",
      opponentCount,
      isActive: false,
      isRunning: false,
      isCompleted: false,
      currentIndex: 0,
      elapsedTime: 0,
      leaderboard: []
    };
  }

  _buildCheckpointSeries(path) {
    if (!Array.isArray(path) || path.length === 0) {
      return null;
    }
    const checkpoints = [];
    for (let index = 0; index < path.length; index += 1) {
      const current = path[index];
      const prev = index > 0 ? path[index - 1] : null;
      const next = index < path.length - 1 ? path[index + 1] : null;
      let dir = null;
      if (next) {
        dir = this.directionFromDelta(next.x - current.x, next.y - current.y);
      } else if (prev) {
        dir = this.directionFromDelta(current.x - prev.x, current.y - prev.y);
      }
      if (!dir) {
        dir = "N";
      }
      const entryDir = prev ? this.directionFromDelta(current.x - prev.x, current.y - prev.y) : null;
      const exitDir = next ? this.directionFromDelta(next.x - current.x, next.y - current.y) : null;
      const geometry = this._computeCheckpointGeometry(current.x, current.y, dir, entryDir, exitDir);
      checkpoints.push({
        tileX: current.x,
        tileY: current.y,
        world: geometry.center,
        dir,
        line: geometry.line,
        flagPositions: geometry.flags,
        type: index === 0 ? "start" : index === path.length - 1 ? "finish" : "checkpoint",
        index,
        reached: index === 0
      });
    }
    return {
      checkpoints,
      start: checkpoints[0] || null,
      finish: checkpoints.length ? checkpoints[checkpoints.length - 1] : null,
      length: path.length
    };
  }

  serializeTimeTrials() {
    const serializePoint = (point) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
    const events = Array.isArray(this.timeTrialEvents)
      ? this.timeTrialEvents.map((trial) => ({
          id: trial.id ?? null,
          chunkKey: trial.chunkKey ?? null,
          eventType: trial.eventType ?? "timeTrial",
          path: Array.isArray(trial.path) ? trial.path.map((p) => ({ x: p.x, y: p.y })) : [],
          checkpoints: Array.isArray(trial.checkpoints)
            ? trial.checkpoints.map((cp) => ({
                tileX: cp.tileX,
                tileY: cp.tileY,
                dir: cp.dir,
                type: cp.type,
                index: cp.index ?? 0,
                reached: !!cp.reached,
                world: serializePoint(cp.world),
                line: cp.line
                  ? {
                      start: serializePoint(cp.line.start),
                      end: serializePoint(cp.line.end)
                    }
                  : null,
                flagPositions: Array.isArray(cp.flagPositions)
                  ? cp.flagPositions.map((pos) => serializePoint(pos))
                  : []
              }))
            : [],
          length: trial.length ?? (trial.path ? trial.path.length : 0),
          opponentCount: trial.opponentCount ?? null,
          isActive: !!trial.isActive,
          isRunning: !!trial.isRunning,
          isCompleted: !!trial.isCompleted,
          currentIndex: trial.currentIndex ?? 0,
          elapsedTime: trial.elapsedTime ?? 0,
          finishTime: trial.finishTime ?? null,
          leaderboard: Array.isArray(trial.leaderboard)
            ? trial.leaderboard.map((entry) => ({ ...entry }))
            : []
        }))
      : [];
    return {
      idCounter: this.timeTrialIdCounter ?? 1,
      raceIdCounter: this.aiRaceIdCounter ?? 1,
      events
    };
  }

  restoreTimeTrials(state = {}) {
    const deserializePoint = (point) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
    const events = Array.isArray(state.events) ? state.events : [];
    this.timeTrialEvents = [];
    if (!(this.chunkTimeTrials instanceof Map)) {
      this.chunkTimeTrials = new Map();
    } else {
      this.chunkTimeTrials.clear();
    }
    this.timeTrialIdCounter = Number.isFinite(state.idCounter) ? state.idCounter : 1;
    this.aiRaceIdCounter = Number.isFinite(state.raceIdCounter) ? state.raceIdCounter : 1;
    for (const raw of events) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const checkpoints = Array.isArray(raw.checkpoints)
        ? raw.checkpoints.map((cp) => ({
            tileX: cp.tileX,
            tileY: cp.tileY,
            dir: cp.dir,
            type: cp.type,
            index: cp.index ?? 0,
            reached: !!cp.reached,
            world: deserializePoint(cp.world),
            line: cp.line
              ? {
                  start: deserializePoint(cp.line.start),
                  end: deserializePoint(cp.line.end)
                }
              : null,
            flagPositions: Array.isArray(cp.flagPositions)
              ? cp.flagPositions.map((pos) => deserializePoint(pos))
              : []
          }))
        : [];
      const isAiRace = raw.eventType === "aiRace";
      const trialId = Number.isFinite(raw.id)
        ? raw.id
        : isAiRace
          ? this.aiRaceIdCounter++
          : this.timeTrialIdCounter++;
      const trial = {
        id: trialId,
        chunkKey: raw.chunkKey ?? null,
        path: Array.isArray(raw.path) ? raw.path.map((p) => ({ x: p.x, y: p.y })) : [],
        checkpoints,
        start: checkpoints[0] ?? null,
        finish: checkpoints.length ? checkpoints[checkpoints.length - 1] : null,
        length: raw.length ?? (raw.path ? raw.path.length : 0),
        eventType: isAiRace ? "aiRace" : "timeTrial",
        opponentCount: raw.opponentCount ?? (isAiRace ? AI_RACE_OPPONENT_COUNT : null),
        isActive: !!raw.isActive,
        isRunning: !!raw.isRunning,
        isCompleted: !!raw.isCompleted,
        currentIndex: raw.currentIndex ?? 0,
        elapsedTime: raw.elapsedTime ?? 0,
        finishTime: raw.finishTime ?? null,
        leaderboard: Array.isArray(raw.leaderboard)
          ? raw.leaderboard.map((entry) => ({ ...entry }))
          : []
      };
      this.timeTrialEvents.push(trial);
      if (trial.chunkKey) {
        const bucket = this.chunkTimeTrials.get(trial.chunkKey) || [];
        bucket.push(trial);
        this.chunkTimeTrials.set(trial.chunkKey, bucket);
      }
    }
    return this.timeTrialEvents;
  }

  _computeCheckpointGeometry(tileX, tileY, dirKey, entryDir = null, exitDir = null) {
    const centerX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const centerY = tileY * TILE_SIZE + TILE_SIZE / 2;
    const center = { x: centerX, y: centerY };
    const dir = TRAFFIC_DIRECTIONS[dirKey] || TRAFFIC_DIRECTIONS.N;
    const halfSpan = TIME_TRIAL_LINE_HALF_SPAN;
    const turnEntry = entryDir && exitDir && entryDir !== exitDir && this.oppositeDirection(entryDir) !== exitDir;
    if (turnEntry) {
      const entryVec = TRAFFIC_DIRECTIONS[entryDir] || TRAFFIC_DIRECTIONS.N;
      const exitVec = TRAFFIC_DIRECTIONS[exitDir] || TRAFFIC_DIRECTIONS.N;
      const sumX = (entryVec.dx ?? 0) + (exitVec.dx ?? 0);
      const sumY = (entryVec.dy ?? 0) + (exitVec.dy ?? 0);
      const useAntiDiagonal = sumX * sumY >= 0;
      const tileMinX = tileX * TILE_SIZE;
      const tileMinY = tileY * TILE_SIZE;
      const tileMaxX = tileMinX + TILE_SIZE;
      const tileMaxY = tileMinY + TILE_SIZE;
      const start = useAntiDiagonal
        ? { x: tileMaxX, y: tileMinY }
        : { x: tileMinX, y: tileMinY };
      const end = useAntiDiagonal
        ? { x: tileMinX, y: tileMaxY }
        : { x: tileMaxX, y: tileMaxY };
      return {
        center,
        line: { start, end },
        flags: [start, end]
      };
    }
    const perpendicular = { x: -dir.dy, y: dir.dx };
    const start = {
      x: center.x + perpendicular.x * halfSpan,
      y: center.y + perpendicular.y * halfSpan
    };
    const end = {
      x: center.x - perpendicular.x * halfSpan,
      y: center.y - perpendicular.y * halfSpan
    };
    return {
      center,
      line: { start, end },
      flags: [start, end]
    };
  }

  findTimeTrialStartAt(tileX, tileY) {
    if (!this.timeTrialEvents || this.timeTrialEvents.length === 0) {
      return null;
    }
    for (const trial of this.timeTrialEvents) {
      if (!trial || trial.eventType !== "timeTrial" || trial.isActive) {
        continue;
      }
      const start = trial.start;
      if (start && start.tileX === tileX && start.tileY === tileY) {
        return trial;
      }
    }
    return null;
  }

  findAiRaceStartAt(tileX, tileY) {
    if (!this.timeTrialEvents || this.timeTrialEvents.length === 0) {
      return null;
    }
    let fallbackTrial = null;
    for (const event of this.timeTrialEvents) {
      if (!event || event.isActive) {
        continue;
      }
      const start = event.start;
      if (!start || start.tileX !== tileX || start.tileY !== tileY) {
        continue;
      }
      if (event.eventType === "aiRace") {
        return event;
      }
      if (!fallbackTrial && event.eventType !== "aiRace") {
        fallbackTrial = event;
      }
    }
    if (!fallbackTrial) {
      return null;
    }
    const race = this._createAiRaceDefinition(
      Array.isArray(fallbackTrial.path)
        ? fallbackTrial.path.map((point) => ({ x: point.x, y: point.y }))
        : []
    );
    if (!race) {
      return null;
    }
    race.id = this.aiRaceIdCounter++;
    race.chunkKey = fallbackTrial.chunkKey ?? null;
    this.timeTrialEvents.push(race);
    return race;
  }

  ensureChunkRoad(chunkX, chunkY) {
    const key = `${chunkX},${chunkY}`;
    if (this.generatedChunks.has(key)) {
      return;
    }
    this.generatedChunks.add(key);
    this.chunkGenerationDepth = (this.chunkGenerationDepth || 0) + 1;

    const startX = chunkX * ZONE_SIZE;
    const startY = chunkY * ZONE_SIZE;
    const endX = startX + ZONE_SIZE;
    const endY = startY + ZONE_SIZE;
    const chunkCenterX = (startX + endX) / 2;
    const chunkCenterY = (startY + endY) / 2;
    const chunkZone = getZone(chunkCenterX, chunkCenterY);

    const grid = this.generateChunkGrid(chunkX, chunkY, startX, startY, endX, endY);

    const rowExtend = Math.max(grid.rowSpacing, MIN_ROAD_LENGTH);
    for (const row of grid.rows) {
      this.tracePath(startX - rowExtend, row, endX + rowExtend, row);
    }

    const columnExtend = Math.max(grid.columnSpacing, MIN_ROAD_LENGTH);
    for (const column of grid.columns) {
      this.tracePath(column, startY - columnExtend, column, endY + columnExtend);
    }
    this._repairRoadConnectionsInBounds(startX - 1, endX + 1, startY - 1, endY + 1);
    if (chunkZone === "city") {
      this._generateTimeTrialsForChunk(chunkX, chunkY);
    } else if (!this.chunkTimeTrials.has(key)) {
      this.chunkTimeTrials.set(key, []);
    }
    this.chunkGenerationDepth -= 1;
    if (this.chunkGenerationDepth <= 0) {
      this.chunkGenerationDepth = 0;
      this.flushPendingTrafficSegments();
      this.flushPendingTrafficTiles();
    }
  }

  generateChunkGrid(chunkX, chunkY, startX, startY, endX, endY) {
    const centerX = Math.round((startX + endX) / 2);
    const centerY = Math.round((startY + endY) / 2);
    const zone = getZone(centerX, centerY);
    const chunkSeed = hashCoordinates(chunkX, chunkY ^ WORLD_SEED);

    let rowSpacing;
    let columnSpacing;
    let rowJitter;
    let columnJitter;

    if (zone === "city") {
      rowSpacing = 8;
      columnSpacing = 8;
      rowJitter = 1;
      columnJitter = 1;
    } else {
      rowSpacing = 30;
      columnSpacing = 30;
      rowJitter = 4;
      columnJitter = 4;
    }

    const rows = this.generateGridLines(
      startY,
      endY,
      rowSpacing,
      rowJitter,
      chunkSeed ^ 0x9e3779b9
    );

    const columns = this.generateGridLines(
      startX,
      endX,
      columnSpacing,
      columnJitter,
      chunkSeed ^ 0x7f4a7c15
    );

    if (rows.length === 0) {
      rows.push(Math.round((startY + endY) / 2));
    }
    if (columns.length === 0) {
      columns.push(Math.round((startX + endX) / 2));
    }

    return {
      rows,
      columns,
      rowSpacing,
      columnSpacing
    };
  }

  generateGridLines(start, end, spacing, jitterRange, seed) {
    const lines = new Set();
    const margin = spacing * 2;
    const firstIndex = Math.floor((start - margin) / spacing);
    const lastIndex = Math.ceil((end + margin) / spacing);

    for (let idx = firstIndex; idx <= lastIndex; idx += 1) {
      const base = idx * spacing;
      let jitter = 0;
      if (jitterRange > 0) {
        const hash = hashCoordinates(idx, seed);
        jitter = (hash % (jitterRange * 2 + 1)) - jitterRange;
      }
      const coord = Math.round(base + jitter);
      if (coord >= start && coord <= end) {
        lines.add(coord);
      }
    }

    return Array.from(lines).sort((a, b) => a - b);
  }


  directionFromDelta(dx, dy) {
    if (dx === 0 && dy < 0) {
      return "N";
    }
    if (dx === 0 && dy > 0) {
      return "S";
    }
    if (dx > 0 && dy === 0) {
      return "E";
    }
    if (dx < 0 && dy === 0) {
      return "W";
    }
    throw new Error(`Unsupported direction delta (${dx}, ${dy})`);
  }

  oppositeDirection(dir) {
    switch (dir) {
      case "N":
        return "S";
      case "S":
        return "N";
      case "E":
        return "W";
      case "W":
        return "E";
      default:
        return null;
    }
  }

  getTile(x, y) {
    this.ensureChunkRoad(Math.floor(x / ZONE_SIZE), Math.floor(y / ZONE_SIZE));
    this.ensureInfrastructure(x, y);
    const key = this.tileKey(x, y);
    if (this.tileCache.has(key)) {
      return this.tileCache.get(key);
    }

    let tile;
    const road = this.roadTiles.get(key);

    if (road) {
      const code = this.determineRoadTileCode(x, y, road);
      const definition = this.tileset[code];
      tile = {
        code,
        baseSprite: definition.baseSprite || null,
        overlaySprite: definition.overlaySprite || null,
        solid: Boolean(definition.solid),
        color: definition.color || null,
        collider: null
      };
      this.buildingTiles.delete(key);
      const existing = this.solidBodies.get(key);
      if (existing && existing.collisionType === "building") {
        this.system.remove(existing);
        this.solidBodies.delete(key);
      }
    } else {
      const zone = getZone(x, y);
      const adjacentRoad =
        this.roadTiles.has(this.tileKey(x + 1, y)) ||
        this.roadTiles.has(this.tileKey(x - 1, y)) ||
        this.roadTiles.has(this.tileKey(x, y + 1)) ||
        this.roadTiles.has(this.tileKey(x, y - 1));

      let code = "G";
      if (adjacentRoad) {
        const buildingCode = this.selectBuildingCode(x, y, zone);
        if (buildingCode) {
          code = buildingCode;
        }
      }

      const definition = this.tileset[code] || this.tileset.G;
      tile = {
        code,
        baseSprite: definition.baseSprite || null,
        overlaySprite: definition.overlaySprite || null,
        solid: Boolean(definition.solid),
        color: definition.color || null,
        collider: null
      };

      if (BUILDING_CODES.includes(code)) {
        this.buildingTiles.add(key);
      } else {
        this.buildingTiles.delete(key);
      }

      if (tile.solid && definition.collider) {
        const { width: sourceWidth, height: sourceHeight } = definition.collider;
      const maxDimension = TILE_SIZE * 0.92;
      const scale = Math.min(maxDimension / sourceWidth, maxDimension / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        tile.collider = {
          width,
          height,
          offsetX: (TILE_SIZE - width) / 2,
          offsetY: TILE_SIZE - height
        };
        this.ensureCollider(x, y, tile);
      }
    }

    this.tileCache.set(key, tile);
    return tile;
  }

  ensureCollider(x, y, tile) {
    const key = this.tileKey(x, y);
    if (this.solidBodies.has(key)) {
      return;
    }

    const offsetX = tile.collider ? tile.collider.offsetX : 0;
    const offsetY = tile.collider ? tile.collider.offsetY : 0;
    const width = tile.collider ? tile.collider.width : TILE_SIZE;
    const height = tile.collider ? tile.collider.height : TILE_SIZE;

    const body = this.system.createBox(
      { x: x * TILE_SIZE + offsetX, y: y * TILE_SIZE + offsetY },
      width,
      height,
      { isStatic: true }
    );

    body.collisionType = "building";
    this.solidBodies.set(key, body);
  }

  draw(ctx, camera, assets) {
    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;

    const startCol = Math.floor(camera.x / TILE_SIZE) - 1;
    const endCol = Math.ceil((camera.x + canvasWidth) / TILE_SIZE) + 1;
    const startRow = Math.floor(camera.y / TILE_SIZE) - 1;
    const endRow = Math.ceil((camera.y + canvasHeight) / TILE_SIZE) + 1;

    for (let row = startRow; row < endRow; row += 1) {
      for (let col = startCol; col < endCol; col += 1) {
        const tile = this.getTile(col, row);
        const screenX = col * TILE_SIZE - camera.x;
        const screenY = row * TILE_SIZE - camera.y;

        if (tile.baseSprite) {
          const sprite = assets[tile.baseSprite];
          if (sprite) {
            ctx.drawImage(sprite, screenX, screenY, TILE_SIZE, TILE_SIZE);
          } else {
            ctx.fillStyle = tile.color || "#1f2937";
            ctx.fillRect(screenX, screenY, TILE_SIZE, TILE_SIZE);
          }
        } else {
          ctx.fillStyle = tile.color || "#1f2937";
          ctx.fillRect(screenX, screenY, TILE_SIZE, TILE_SIZE);
        }

        if (tile.overlaySprite) {
          const overlay = assets[tile.overlaySprite];
          if (overlay) {
            const maxDimension = TILE_SIZE * 0.92;
            const scale = Math.min(
              maxDimension / overlay.width,
              maxDimension / overlay.height
            );
            const overlayWidth = overlay.width * scale;
            const overlayHeight = overlay.height * scale;
            const overlayX = screenX + (TILE_SIZE - overlayWidth) / 2;
            const overlayY = screenY + TILE_SIZE - overlayHeight;
            ctx.drawImage(overlay, overlayX, overlayY, overlayWidth, overlayHeight);
          }
        }
      }
    }

    this._drawTimeTrialMarkers(ctx, camera, assets);
  }

  _drawTimeTrialMarkers(ctx, camera, assets) {
    if (!this.timeTrialEvents || this.timeTrialEvents.length === 0) {
      return;
    }
    const flag = assets?.checkpoint_flag;
    if (!flag) {
      return;
    }
    const viewMinX = camera.x - TILE_SIZE;
    const viewMinY = camera.y - TILE_SIZE;
    const viewMaxX = camera.x + ctx.canvas.width + TILE_SIZE;
    const viewMaxY = camera.y + ctx.canvas.height + TILE_SIZE;
    const flagSize = 28;
    for (const trial of this.timeTrialEvents) {
      if (!trial?.isActive || !Array.isArray(trial.checkpoints)) {
        continue;
      }
      for (const checkpoint of trial.checkpoints) {
        const line = checkpoint?.line;
        if (!line) {
          continue;
        }
        const state = this._checkpointVisualState(trial, checkpoint);
        const sx = line.start.x - camera.x;
        const sy = line.start.y - camera.y;
        const ex = line.end.x - camera.x;
        const ey = line.end.y - camera.y;
        const minX = Math.min(line.start.x, line.end.x);
        const maxX = Math.max(line.start.x, line.end.x);
        const minY = Math.min(line.start.y, line.end.y);
        const maxY = Math.max(line.start.y, line.end.y);
        if (maxX < viewMinX || minX > viewMaxX || maxY < viewMinY || minY > viewMaxY) {
          continue;
        }
        ctx.save();
        ctx.lineWidth = 6;
        ctx.strokeStyle = this._checkpointStrokeStyle(state, checkpoint.type);
        ctx.globalAlpha = state === "passed" ? 0.55 : state === "current" ? 1 : 0.4;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.restore();
        if (Array.isArray(checkpoint.flagPositions)) {
          for (const pos of checkpoint.flagPositions) {
            if (!pos) {
              continue;
            }
            if (
              pos.x < viewMinX ||
              pos.x > viewMaxX ||
              pos.y < viewMinY ||
              pos.y > viewMaxY
            ) {
              continue;
            }
            const screenX = pos.x - camera.x - flagSize / 2;
            const screenY = pos.y - camera.y - flagSize;
            ctx.save();
            ctx.globalAlpha = state === "passed" ? 0.6 : state === "current" ? 1 : 0.75;
            ctx.drawImage(flag, screenX, screenY, flagSize, flagSize);
            ctx.restore();
          }
        }
      }
    }
  }

  _checkpointVisualState(trial, checkpoint) {
    if (!trial) {
      return "pending";
    }
    if (trial.isCompleted || checkpoint.reached) {
      return "passed";
    }
    if (trial.isRunning && checkpoint.index === trial.currentIndex) {
      return "current";
    }
    return "pending";
  }

  _checkpointStrokeStyle(state, type) {
    if (state === "passed") {
      return "#4ade80";
    }
    if (state === "current") {
      return "#fde047";
    }
    if (type === "start") {
      return "#38bdf8";
    }
    if (type === "finish") {
      return "#fb923c";
    }
    return "#fecdd3";
  }
}

class MiniMap {
  constructor(canvas) {
    this.canvas = canvas instanceof HTMLCanvasElement ? canvas : null;
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.chunkSize = ZONE_SIZE;
    this.scale =
      this.canvas && this.canvas.width
        ? this.canvas.width / this.chunkSize
        : 4;
    this.baseCanvas = null;
    this.baseCtx = null;
    this.prevChunkKey = null;
    this.originTileX = 0;
    this.originTileY = 0;
    if (this.canvas) {
      this.baseCanvas = document.createElement("canvas");
      this.baseCanvas.width = this.canvas.width;
      this.baseCanvas.height = this.canvas.height;
      this.baseCtx = this.baseCanvas.getContext("2d");
    }
    this.visible = true;
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (this.canvas) {
      this.canvas.classList.toggle("is-hidden", !visible);
    }
  }

  update(level, worldPosition, headingRad = 0) {
    if (!this.visible || !this.ctx || !level || !worldPosition) {
      return;
    }

    const tileX = worldPosition.x / TILE_SIZE;
    const tileY = worldPosition.y / TILE_SIZE;
    const chunkX = Math.floor(tileX / this.chunkSize);
    const chunkY = Math.floor(tileY / this.chunkSize);
    const chunkKey = `${chunkX},${chunkY}`;

    if (chunkKey !== this.prevChunkKey) {
      this.drawChunk(level, chunkX, chunkY);
      this.prevChunkKey = chunkKey;
    }

    if (this.baseCanvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(this.baseCanvas, 0, 0);
    }

    this._drawTimeTrialPixels(level);

    const localTileX = tileX - this.originTileX;
    const localTileY = tileY - this.originTileY;
    const px = localTileX * this.scale;
    const py = localTileY * this.scale;
    const baseSize = Math.max(4, this.scale * 1.8);

    this.ctx.save();
    this.ctx.translate(px, py);
    this.ctx.rotate(headingRad);
    this.ctx.fillStyle = "#38bdf8";
    this.ctx.beginPath();
    this.ctx.moveTo(baseSize, 0);
    this.ctx.lineTo(-baseSize * 0.6, baseSize * 0.7);
    this.ctx.lineTo(-baseSize * 0.6, -baseSize * 0.7);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.restore();
  }

  _drawTimeTrialPixels(level) {
    if (!this.ctx || !level || !Array.isArray(level.timeTrialEvents) || level.timeTrialEvents.length === 0) {
      return;
    }
    const chunkMinX = this.originTileX;
    const chunkMinY = this.originTileY;
    const chunkMaxX = chunkMinX + this.chunkSize;
    const chunkMaxY = chunkMinY + this.chunkSize;
    const pixelSize = Math.max(2, this.scale * 0.65);
    this.ctx.fillStyle = "#ef4444";
    for (const trial of level.timeTrialEvents) {
      if (!trial || !trial.checkpoints) {
        continue;
      }
      const nodes = trial.isActive
        ? trial.checkpoints
        : trial.start
          ? [trial.start]
          : [];
      for (const checkpoint of nodes) {
        const tx = checkpoint?.tileX;
        const ty = checkpoint?.tileY;
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
          continue;
        }
        if (tx < chunkMinX || tx >= chunkMaxX || ty < chunkMinY || ty >= chunkMaxY) {
          continue;
        }
        const localX = (tx - chunkMinX) * this.scale;
        const localY = (ty - chunkMinY) * this.scale;
        this.ctx.fillRect(localX, localY, pixelSize, pixelSize);
      }
    }
  }

  drawChunk(level, chunkX, chunkY) {
    if (!this.baseCtx) {
      return;
    }
    this.baseCtx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    this.baseCtx.fillStyle = "rgba(15, 23, 42, 0.45)";
    this.baseCtx.fillRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);

    const originTileX = chunkX * this.chunkSize;
    const originTileY = chunkY * this.chunkSize;
    this.originTileX = originTileX;
    this.originTileY = originTileY;

    for (let ty = 0; ty < this.chunkSize; ty += 1) {
      for (let tx = 0; tx < this.chunkSize; tx += 1) {
        const tile = level.getTile(originTileX + tx, originTileY + ty);
        this.baseCtx.fillStyle = this.colorForTile(tile);
        this.baseCtx.fillRect(
          tx * this.scale,
          ty * this.scale,
          this.scale,
          this.scale
        );
      }
    }

    this.baseCtx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    this.baseCtx.lineWidth = 1;
    this.baseCtx.strokeRect(
      0.5,
      0.5,
      this.baseCanvas.width - 1,
      this.baseCanvas.height - 1
    );
  }

  colorForTile(tile) {
    if (!tile) {
      return "rgba(30, 41, 59, 0.4)";
    }
    switch (tile.code) {
      case "W":
        return "rgba(14, 165, 233, 0.75)";
      case "S":
        return "rgba(249, 115, 22, 0.9)";
      case "R":
      case "V":
      case "I":
        return "rgba(148, 163, 184, 0.85)";
      case "B":
      case "D":
      case "F":
      case "H":
        return "rgba(248, 250, 252, 0.82)";
      case "G":
      default:
        return "rgba(30, 64, 175, 0.18)";
    }
  }
}

class Camera {
  constructor(canvas, level) {
    this.canvas = canvas;
    this.level = level;
    this.x = 0;
    this.y = 0;
    this.smoothing = 6;
    this.updateViewport();

    window.addEventListener("resize", () => this.updateViewport());
  }

  updateViewport() {
    const rect = this.canvas.getBoundingClientRect();
    this.viewportWidth = rect.width || this.canvas.width;
    this.viewportHeight = rect.height || this.canvas.height;
  }

  update(target, dt) {
    const desiredX = target.body.x - this.viewportWidth / 2;
    const desiredY = target.body.y - this.viewportHeight / 2;
    const smoothing = 1 - Math.exp(-this.smoothing * dt);

    this.x += (desiredX - this.x) * smoothing;
    this.y += (desiredY - this.y) * smoothing;

    if (Number.isFinite(this.level.pixelWidth)) {
      const maxX = Math.max(0, this.level.pixelWidth - this.viewportWidth);
      this.x = clamp(this.x, 0, maxX);
    }

    if (Number.isFinite(this.level.pixelHeight)) {
      const maxY = Math.max(0, this.level.pixelHeight - this.viewportHeight);
      this.y = clamp(this.y, 0, maxY);
    }
  }
}

class Vehicle {
  constructor(system, startPose, carConfig, carSpec, options = {}) {
    this.system = system;
    this.startPose = { ...startPose };
    this.bodyWidth = 46;
    this.bodyHeight = 24;
    this.body = system.createBox(
      { x: startPose.x, y: startPose.y },
      this.bodyWidth,
      this.bodyHeight,
      { isStatic: false, isCentered: true }
    );
    this.body.collisionType = "car";
    this.body.__vehicleRef = this;
    this.vehicleId = VEHICLE_ID_SEQUENCE++;
    this.body.setAngle(startPose.angle);

    this.renderWidth = 48;
    this.collisions = 0;
    const carId = carSpec?.id ?? carConfig?.id;
    const useProvidedConfig = options?.precomputedConfig === true;
    this.carConfig = useProvidedConfig
      ? cloneCarConfig(carConfig)
      : createCarConfigFromSpec(carConfig, { carId });
    this.physics = new PhysicsCar(this.carConfig, {
      pixelsPerMeter: PIXELS_PER_METER,
      position: { x: startPose.x, y: startPose.y },
      heading: startPose.angle
    });
    this.transmissionMode = "auto";
    this.physics.setManualMode(false);
    this.levelRef = options.level ?? null;
    // Choose sprite key for this vehicle instance based on the carSpec (best-fit)
    this.carSpec = carSpec || null;
    this.spriteKey = chooseCarSprite(this.carSpec);
  }

  reset({ preserveCollisions = true } = {}) {
    this.body.setAngle(this.startPose.angle);
    this.body.setPosition(this.startPose.x, this.startPose.y);
    this.physics.resetState({
      position: { x: this.startPose.x, y: this.startPose.y },
      heading: this.startPose.angle
    });
    if (!preserveCollisions) {
      this.collisions = 0;
    }
  }

  update(inputState, dt, bounds) {
    const { forward, reverse, left, right, brake } = inputState;
    const isManual = this.isManualTransmission();
    let throttleInput = 0;
    let brakeInput = brake ? 1 : 0;
    const steerInput = (right ? 1 : 0) - (left ? 1 : 0);

    const longitudinalSpeed = this.physics.getLongitudinalSpeed();
    const absLongitudinal = Math.abs(longitudinalSpeed);
    const forwardPressed = forward && !reverse;
    const reversePressed = reverse && !forward;
    const movingBackward = longitudinalSpeed < -0.5;

    if (forwardPressed) {
      throttleInput = 1;
    }

    if (reversePressed) {
      if (absLongitudinal < 0.6) {
        throttleInput = -1;
      } else if (longitudinalSpeed > 0) {
        throttleInput = 0;
        brakeInput = Math.max(brakeInput, 0.6);
      } else {
        throttleInput = -1;
      }
    }

    if (!isManual && movingBackward && forwardPressed) {
      throttleInput = 0;
      brakeInput = Math.max(brakeInput, 1);
    }

    const inManualReverse = isManual && this.physics.reverseMode;
    if (inManualReverse && forwardPressed) {
      throttleInput = 0;
      brakeInput = Math.max(brakeInput, 1);
    }

    if (forward && reverse) {
      throttleInput = 0;
    }

    const throttleScale =
      typeof inputState?.throttleScale === "number"
        ? clamp(inputState.throttleScale, 0, 1)
        : 1;
    if (throttleInput > 0) {
      throttleInput *= throttleScale;
    } else if (throttleInput < 0) {
      throttleInput *= throttleScale;
    }

    this.physics.update(throttleInput, brakeInput, steerInput, dt);

    const worldPos = this.physics.getWorldPosition();
    this.body.setAngle(this.physics.heading);
    this.body.setPosition(worldPos.x, worldPos.y);

    const beforeX = this.body.x;
    const beforeY = this.body.y;
    const velocityBeforeCollision = {
      x: this.physics.velocity.x,
      y: this.physics.velocity.y
    };
    this._collisionVelocitySnapshot = { ...velocityBeforeCollision };
    let collided = false;
    let overlapWorldX = 0;
    let overlapWorldY = 0;
    let clampResolveX = 0;
    let clampResolveY = 0;
    let displacementResolveX = 0;
    let displacementResolveY = 0;
    const carCollisionMap = new Map();

    this.system.separateBody(this.body, (collision) => {
      collided = true;
      const overlapX = collision?.overlapV?.x ?? 0;
      const overlapY = collision?.overlapV?.y ?? 0;
      const isCarCollision =
        collision?.a?.collisionType === "car" || collision?.b?.collisionType === "car";
      if (isCarCollision) {
        const otherBody = collision?.a === this.body ? collision?.b : collision?.a;
        const otherVehicle = otherBody?.__vehicleRef ?? null;
        if (otherVehicle && otherVehicle !== this) {
          const key = otherVehicle.vehicleId;
          const existing = carCollisionMap.get(key);
          if (existing) {
            existing.overlapX += overlapX;
            existing.overlapY += overlapY;
          } else {
            carCollisionMap.set(key, {
              other: otherVehicle,
              overlapX,
              overlapY
            });
          }
        }
      } else {
        overlapWorldX += overlapX;
        overlapWorldY += overlapY;
      }
      return true;
    });

    if (collided) {
      const dx = this.body.x - beforeX;
      const dy = this.body.y - beforeY;
      if (dx !== 0 || dy !== 0) {
        this.physics.applyWorldDisplacement(dx, dy);
        displacementResolveX += dx;
        displacementResolveY += dy;
      }
    }

    const halfWidth = this.bodyWidth / 2;
    const halfHeight = this.bodyHeight / 2;
    const clampedX = clamp(this.body.x, bounds.minX + halfWidth, bounds.maxX - halfWidth);
    const clampedY = clamp(this.body.y, bounds.minY + halfHeight, bounds.maxY - halfHeight);

    if (clampedX !== this.body.x || clampedY !== this.body.y) {
      const dx = clampedX - this.body.x;
      const dy = clampedY - this.body.y;
      this.body.setPosition(clampedX, clampedY);
      this.physics.applyWorldDisplacement(dx, dy);
      collided = true;
      clampResolveX += dx;
      clampResolveY += dy;
      displacementResolveX += dx;
      displacementResolveY += dy;
    }

    if (collided) {
      let worldResolveX = -overlapWorldX + clampResolveX;
      let worldResolveY = -overlapWorldY + clampResolveY;
      if (Math.hypot(worldResolveX, worldResolveY) < 1e-6) {
        worldResolveX = displacementResolveX;
        worldResolveY = displacementResolveY;
      }
      if (Math.hypot(worldResolveX, worldResolveY) > 1e-6) {
        this._applyCollisionReaction(worldResolveX, worldResolveY, velocityBeforeCollision, false);
      }
      if (carCollisionMap.size > 0) {
        for (const entry of carCollisionMap.values()) {
          this._resolveCarCollisionPair(entry.other, entry.overlapX, entry.overlapY, velocityBeforeCollision);
        }
      }
      this.collisions += 1;
    }

    this.physics.setWorldPosition(this.body.x, this.body.y);
  }

  _applyCollisionReaction(resolveX, resolveY, velocityBefore, collidedWithCar = false) {
    const vel = velocityBefore || { x: this.physics.velocity.x, y: this.physics.velocity.y };
    const normalMag = Math.hypot(resolveX, resolveY);
    if (normalMag < 1e-6) {
      this.physics.dampVelocity(0.35);
      if (this.physics.getSpeedMetersPerSecond() < 0.3) {
        this.physics.stop();
      }
      return;
    }
    const normal = { x: resolveX / normalMag, y: resolveY / normalMag };
    const velNormalMag = vel.x * normal.x + vel.y * normal.y;
    const normalComponent = {
      x: normal.x * velNormalMag,
      y: normal.y * velNormalMag
    };
    const tangentialComponent = {
      x: vel.x - normalComponent.x,
      y: vel.y - normalComponent.y
    };
    const mass = this.physics?.config?.massKg ?? 1200;
    const impactSpeed = Math.abs(velNormalMag);
    const impactEnergy = 0.5 * mass * impactSpeed * impactSpeed;
    const normalAngle = Math.atan2(normal.y, normal.x);
    const velocityAngle = Math.atan2(vel.y, vel.x);
    const impactAngle = normalizeAngle(normalAngle - velocityAngle);
    this.lastCollisionEnergy = impactEnergy;
    this.lastCollisionAngle = impactAngle;
    const efficiency = 0.1;
    const reactionComponent = {
      x: -normalComponent.x * efficiency,
      y: -normalComponent.y * efficiency
    };
    const frictionCoef = this._surfaceFrictionForTile();
    const deltaVelocity = {
      x: (reactionComponent.x - normalComponent.x) * frictionCoef,
      y: (reactionComponent.y - normalComponent.y) * frictionCoef
    };
    const newVelocity = {
      x: vel.x + deltaVelocity.x,
      y: vel.y + deltaVelocity.y
    };
    this.physics.velocity.x = newVelocity.x;
    this.physics.velocity.y = newVelocity.y;
    const deltaVel = { ...deltaVelocity };
    if (Math.hypot(deltaVel.x, deltaVel.y) > 1e-5) {
      this._applyAngularImpulse(deltaVel, normal);
    }
    if (this.physics.getSpeedMetersPerSecond() < 0.15) {
      this.physics.stop();
    }
  }

  _resolveCarCollisionPair(otherVehicle, overlapX, overlapY, baseVelocity) {
    if (!otherVehicle || otherVehicle === this) {
      return;
    }
    if (this.vehicleId > otherVehicle.vehicleId) {
      return;
    }
    let normalVec = {
      x: otherVehicle.body.x - this.body.x,
      y: otherVehicle.body.y - this.body.y
    };
    let normalMag = Math.hypot(normalVec.x, normalVec.y);
    if (normalMag < 1e-6) {
      normalVec = { x: -overlapX, y: -overlapY };
      normalMag = Math.hypot(normalVec.x, normalVec.y);
    }
    if (normalMag < 1e-6) {
      return;
    }
    const normal = { x: normalVec.x / normalMag, y: normalVec.y / normalMag };
    const m1 = this.physics?.config?.massKg ?? 1200;
    const m2 = otherVehicle.physics?.config?.massKg ?? 1200;
    const v1 = baseVelocity || this._collisionVelocitySnapshot || { x: this.physics.velocity.x, y: this.physics.velocity.y };
    const otherSnapshot = otherVehicle._collisionVelocitySnapshot;
    const v2 = otherSnapshot || { x: otherVehicle.physics.velocity.x, y: otherVehicle.physics.velocity.y };
    const relativeNormal = (v2.x - v1.x) * normal.x + (v2.y - v1.y) * normal.y;
    if (relativeNormal >= 0) {
      return;
    }
    const restitution = 0.1;
    const impulseMag = -(1 + restitution) * relativeNormal / ((1 / m1) + (1 / m2));
    const frictionCoef1 = this._surfaceFrictionForTile();
    const frictionCoef2 = otherVehicle._surfaceFrictionForTile();
    const deltaVel1 = {
      x: -(impulseMag / m1) * normal.x * frictionCoef1,
      y: -(impulseMag / m1) * normal.y * frictionCoef1
    };
    const deltaVel2 = {
      x: (impulseMag / m2) * normal.x * frictionCoef2,
      y: (impulseMag / m2) * normal.y * frictionCoef2
    };
    const newVel1 = {
      x: v1.x + deltaVel1.x,
      y: v1.y + deltaVel1.y
    };
    const newVel2 = {
      x: v2.x + deltaVel2.x,
      y: v2.y + deltaVel2.y
    };
    this.physics.velocity.x = newVel1.x;
    this.physics.velocity.y = newVel1.y;
    otherVehicle.physics.velocity.x = newVel2.x;
    otherVehicle.physics.velocity.y = newVel2.y;
    const energyDelta1 = 0.5 * m1 * (deltaVel1.x ** 2 + deltaVel1.y ** 2);
    const energyDelta2 = 0.5 * m2 * (deltaVel2.x ** 2 + deltaVel2.y ** 2);
    const sharedEnergy = (energyDelta1 + energyDelta2) * 0.5;
    this.lastCollisionEnergy = sharedEnergy;
    otherVehicle.lastCollisionEnergy = sharedEnergy;
    const angle = Math.atan2(normal.y, normal.x);
    this.lastCollisionAngle = angle;
    otherVehicle.lastCollisionAngle = angle + Math.PI;
    if (Math.hypot(deltaVel1.x, deltaVel1.y) > 1e-5) {
      this._applyAngularImpulse(deltaVel1, normal);
    }
    if (Math.hypot(deltaVel2.x, deltaVel2.y) > 1e-5) {
      otherVehicle._applyAngularImpulse(deltaVel2, { x: -normal.x, y: -normal.y });
    }
  }

  _applyAngularImpulse(deltaVelocity, normal) {
    if (!this.physics || !deltaVelocity || !normal) {
      return;
    }
    const mass = this.physics.config?.massKg ?? 1200;
    const impulse = {
      x: deltaVelocity.x * mass,
      y: deltaVelocity.y * mass
    };
    const perp = { x: -normal.y, y: normal.x };
    const perpMag = Math.hypot(perp.x, perp.y);
    if (perpMag < 1e-6) {
      return;
    }
    const leverLengthPx = Math.max(this.bodyWidth, this.bodyHeight) * 0.5;
    const lever = {
      x: (perp.x / perpMag) * (leverLengthPx / PIXELS_PER_METER),
      y: (perp.y / perpMag) * (leverLengthPx / PIXELS_PER_METER)
    };
    const torque = (lever.x * impulse.y - lever.y * impulse.x) * 0.1;
    const sizeMeters = Math.max(this.bodyWidth, this.bodyHeight) / PIXELS_PER_METER;
    const inertia = this.physics.inertia || (mass * sizeMeters * sizeMeters) / 12;
    if (!Number.isFinite(inertia) || Math.abs(inertia) < 1e-6) {
      return;
    }
    const deltaOmega = torque / inertia;
    if (Number.isFinite(deltaOmega)) {
      const frictionCoef = this._surfaceFrictionForTile();
      this.physics.angularVelocity += deltaOmega * frictionCoef;
    }
  }

  _surfaceFrictionForTile() {
    const tileX = Math.floor(this.body.x / TILE_SIZE);
    const tileY = Math.floor(this.body.y / TILE_SIZE);
    const level = this.levelRef;
    const tile = level?.getTile?.(tileX, tileY);
    switch (tile?.code) {
      case "W":
        return 0.85;
      case "G":
      case "B":
      case "D":
      case "F":
      case "H":
        return 0.92;
      default:
        return 0.98;
    }
  }

  getSpeed() {
    return this.physics.getSpeedPixelsPerSecond();
  }

  getHeadingDegrees() {
    return ((this.physics.heading * RAD2DEG) % 360 + 360) % 360;
  }

  getPosition() {
    return this.physics.getWorldPosition();
  }

  isManualTransmission() {
    return this.transmissionMode === "manual";
  }

  toggleTransmissionMode() {
    const nextMode = this.isManualTransmission() ? "auto" : "manual";
    this.setTransmissionMode(nextMode);
  }

  setTransmissionMode(mode) {
    const normalized = mode === "manual" ? "manual" : "auto";
    this.transmissionMode = normalized;
    this.physics.setManualMode(normalized === "manual");
    if (normalized === "auto") {
      if (this.physics.gearIndex <= 0) {
        this.physics.gearIndex = Math.min(1, this.physics.config.gearRatios.length - 1);
      }
      this.physics.reverseMode = false;
    }
  }

  shiftUp() {
    if (!this.isManualTransmission()) {
      return false;
    }
    return this.physics.shiftUp();
  }

  shiftDown() {
    if (!this.isManualTransmission()) {
      return false;
    }
    return this.physics.shiftDown();
  }

  getTransmissionLabel() {
    return this.isManualTransmission() ? "Manual" : "Automatic";
  }

  getDisplayGear() {
    if (this.physics.reverseMode || this.physics.gearIndex === -1) {
      return "R";
    }
    if (this.physics.gearIndex === 0) {
      return "N";
    }
    return String(this.physics.gearIndex);
  }

  serializeState() {
    return {
      body: {
        x: this.body.x,
        y: this.body.y,
        angle: this.body.angle
      },
      physics:
        typeof this.physics.serializeState === "function"
          ? this.physics.serializeState()
          : null,
      transmissionMode: this.transmissionMode,
      collisions: this.collisions
    };
  }

  restoreState(state = {}) {
    if (!state || typeof state !== "object") {
      return;
    }

    if (state.physics && typeof this.physics.restoreState === "function") {
      this.physics.restoreState(state.physics);
    }

    const bodyState = state.body || {};
    const physicsPosition = this.physics.getWorldPosition();
    const posX = Number.isFinite(bodyState.x) ? bodyState.x : physicsPosition.x;
    const posY = Number.isFinite(bodyState.y) ? bodyState.y : physicsPosition.y;
    const candidateAngle = Number.isFinite(bodyState.angle)
      ? bodyState.angle
      : Number.isFinite(state.physics?.heading)
        ? state.physics.heading
        : this.physics.heading;

    this.body.setPosition(posX, posY);
    if (Number.isFinite(candidateAngle)) {
      this.body.setAngle(candidateAngle);
      this.physics.heading = candidateAngle;
    } else {
      this.body.setAngle(this.physics.heading);
    }
    this.body.updateBody(true);
    this.physics.setWorldPosition(this.body.x, this.body.y);

    const manualMode = this.physics.manualMode === true;
    if (typeof state.transmissionMode === "string") {
      this.transmissionMode = state.transmissionMode === "manual" ? "manual" : "auto";
      this.physics.manualMode = this.transmissionMode === "manual";
    } else {
      this.transmissionMode = manualMode ? "manual" : "auto";
      this.physics.manualMode = manualMode;
    }

    if (Number.isFinite(state.collisions)) {
      this.collisions = Math.max(0, Math.trunc(state.collisions));
    }
  }

  draw(ctx, camera, assets) {
    const sprite = assets[this.spriteKey] || assets.car_default || assets.car;
    if (!sprite) {
      return;
    }

    const position = this.physics.getWorldPosition();
    const drawX = position.x - camera.x;
    const drawY = position.y - camera.y;
    const renderWidth = this.renderWidth;
    const aspectRatio = sprite.height && sprite.width ? sprite.height / sprite.width : 0.5;
    const renderHeight = renderWidth * aspectRatio;

    ctx.save();
    ctx.translate(drawX, drawY);
    ctx.rotate(this.physics.heading);
    ctx.drawImage(
      sprite,
      -renderWidth / 2,
      -renderHeight / 2,
      renderWidth,
      renderHeight
    );
    ctx.restore();
  }
}

// Simple traffic manager: spawns NPC vehicles that drive on roads. Traffic only
// uses sedan, hatchback and truck-looking sprites (heuristic via chooseCarSprite).
// Vehicles choose random turns at intersection tiles and participate in collisions
// with the player and building colliders (using the existing physics `system`).
class TrafficManager {
  constructor(system, level, assets, player, playerVehicle) {
    this.system = system;
    this.level = level;
    this.assets = assets;
    this.player = player;
    this.playerVehicle = playerVehicle;
    this.vehicles = [];
    this.enabled = true;
    this.TRAFFIC_PER_ROAD = 3;
    this.baseTrafficPerRoad = this.TRAFFIC_PER_ROAD;
    this.allowedSpriteKeys = new Set(["car_Sedan", "car_Hatchback", "car_Truck"]);
    this.spawnedLines = new Set();
    this.pendingSpawns = new Map();
    this.pendingSpawnOrder = [];
    this.pendingSpawnCursor = 0;
    this.backgroundSpawnTimer = null;
    this.activationTimer = null;
    this.spawningEnabled = false;
    this.activationScheduled = false;
    this.globalSpawnCooldown = 0;
    this.pendingRoadLines = [];
    this.pendingTileRequests = [];
    this.spawnTimeRatio = 0.25;
    this.backgroundSpawnPending = false;
    this.spawnFallbackCooldown = 0;
    this.SPAWN_ACTIVATION_DISTANCE = 10;
    this.MAX_PENDING_CHECKS = 48;
    this.MAX_SPAWNS_PER_TICK = 1;
    this.MAX_DEFERRED_ATTEMPTS = 6;
  }

  start() {
    this.enabled = true;
    this._resetSpawnQueue();
    this._clearVehicles();
    this.spawningEnabled = false;
    this.activationScheduled = false;
    if (this.activationTimer != null && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
      window.clearTimeout(this.activationTimer);
    }
    if (this.backgroundSpawnTimer != null && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
      window.clearTimeout(this.backgroundSpawnTimer);
    }
    this.activationTimer = null;
    this.backgroundSpawnTimer = null;
    this._drainPendingSpawns();
  }

  stop() {
    this.enabled = false;
    this._clearVehicles();
    this._resetSpawnQueue();
    if (this.backgroundSpawnTimer != null && typeof window !== "undefined") {
      window.clearTimeout(this.backgroundSpawnTimer);
    }
    this.backgroundSpawnTimer = null;
    this.backgroundSpawnPending = false;
    if (this.activationTimer != null && typeof window !== "undefined") {
      window.clearTimeout(this.activationTimer);
    }
    this.activationTimer = null;
    this.spawningEnabled = false;
    this.activationScheduled = false;
  }

  _clearVehicles() {
    for (const entry of this.vehicles) {
      try {
        if (entry?.veh?.body && typeof this.system.remove === "function") {
          this.system.remove(entry.veh.body);
        }
      } catch (_error) {}
    }
    this.vehicles.length = 0;
    this.spawnedLines.clear();
  }

  _resetSpawnQueue() {
    this.pendingSpawns.clear();
    this.pendingSpawnOrder.length = 0;
    this.pendingSpawnCursor = 0;
    this.pendingRoadLines.length = 0;
    this.pendingTileRequests.length = 0;
  }

  requestSpawnActivation() {
    if (!this.enabled || this.spawningEnabled || this.activationScheduled) {
      return;
    }
    this.activationScheduled = true;
    const activate = () => {
      this.activationScheduled = false;
      this.enableSpawning();
    };
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      this.activationTimer = window.setTimeout(activate, 0);
    } else {
      activate();
    }
  }

  enableSpawning() {
    if (!this.enabled || this.spawningEnabled) {
      return;
    }
    this.spawningEnabled = true;
    this.activationScheduled = false;
    if (this.activationTimer != null && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
      window.clearTimeout(this.activationTimer);
    }
    this.activationTimer = null;
    this._drainPendingSpawns();
    this._drainPendingTiles();
    if (this.vehicles.length === 0 && !this.backgroundSpawnPending) {
      const spawnNow = () => {
        this.backgroundSpawnPending = false;
        if (!this.enabled || !this.spawningEnabled) {
          return;
        }
        this.spawnFallbackCooldown = 1.5;
        this._spawnFallback(this.baseTrafficPerRoad);
      };
      if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
        this.backgroundSpawnPending = true;
        this.backgroundSpawnTimer = window.setTimeout(spawnNow, 500);
      } else {
        spawnNow();
      }
    }
  }

  _isCityTile(tileX, tileY) {
    try {
      return getZone(tileX * TILE_SIZE, tileY * TILE_SIZE) === "city";
    } catch (_error) {
      return false;
    }
  }

  _lineLimitForTile(tileX, tileY) {
    return this._isCityTile(tileX, tileY) ? this.TRAFFIC_PER_ROAD * 2 : this.TRAFFIC_PER_ROAD;
  }

  _computeLineLimit(lineKey) {
    let limit = this.TRAFFIC_PER_ROAD;
    for (const entry of this.vehicles) {
      if (entry?.state?.lineKey === lineKey) {
        const tileX = entry.state.currentTileX;
        const tileY = entry.state.currentTileY;
        if (this._isCityTile(tileX, tileY)) {
          limit = Math.max(limit, this.TRAFFIC_PER_ROAD * 2);
          break;
        }
      }
    }
    return limit;
  }

  update(dt) {
    if (!this.enabled) {
      return;
    }

    this._processDeferredSpawns(dt);

    if (this.vehicles.length === 0) {
      return;
    }
    const bounds = this.level.bounds;
    for (let index = this.vehicles.length - 1; index >= 0; index -= 1) {
      const entry = this.vehicles[index];
      if (!entry || !entry.veh) {
        this.vehicles.splice(index, 1);
        continue;
      }
      const alive = this._updateVehicle(entry, dt, bounds);
      if (!alive) {
        try {
          if (entry.veh?.body && typeof this.system.remove === "function") {
            this.system.remove(entry.veh.body);
          }
        } catch (_error) {}
        this.vehicles.splice(index, 1);
      }
    }
  }

  spawnForRoadLine(axis, coord) {
    this._enqueueRoadLine(axis, coord);
  }

  _buildCandidates() {
    const candidates = CAR_CATALOG.filter((car) => {
      try {
        const key = chooseCarSprite(car);
        return this.allowedSpriteKeys.has(key);
      } catch (_error) {
        return false;
      }
    });
    return candidates.length > 0 ? candidates : null;
  }

  _drainPendingSpawns() {
    try {
      if (Array.isArray(globalThis.__pendingRoadLineSpawns) && globalThis.__pendingRoadLineSpawns.length > 0) {
        const queuedLines = globalThis.__pendingRoadLineSpawns.splice(0);
        for (const request of queuedLines) {
          if (!request || !request.axis) {
            continue;
          }
          this._enqueueRoadLine(request.axis, request.coord);
        }
      }
      if (Array.isArray(globalThis.__pendingRoadSpawns) && globalThis.__pendingRoadSpawns.length > 0) {
        const queuedSegments = globalThis.__pendingRoadSpawns.splice(0);
        for (const request of queuedSegments) {
          if (!request) {
            continue;
          }
          if (Number.isFinite(request.fromX) && Number.isFinite(request.fromY)) {
            const axis = request.fromY === request.toY ? "H" : "V";
            const coord = axis === "H" ? request.fromY : request.fromX;
            this._enqueueRoadLine(axis, coord);
          }
        }
      }
      if (Array.isArray(globalThis.__pendingTrafficTiles) && globalThis.__pendingTrafficTiles.length > 0) {
        const queuedTiles = globalThis.__pendingTrafficTiles.splice(0);
        for (const tile of queuedTiles) {
          if (!tile || !Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) {
            continue;
          }
          this.spawnAtRoadTile(tile.tileX, tile.tileY);
        }
      }
    } catch (_error) {}
  }

  _queueSpawn(tileX, tileY, lineKeyHint = null) {
    if (
      !Number.isFinite(tileX) ||
      !Number.isFinite(tileY) ||
      !this._isRoadTile(tileX, tileY)
    ) {
      return false;
    }
    const key = `${tileX},${tileY}`;
    const existing = this.pendingSpawns.get(key);
    const spawnMultiplier = this._isCityTile(tileX, tileY) ? 2 : 1;
    if (existing) {
      if (lineKeyHint && !existing.lineKeyHint) {
        existing.lineKeyHint = lineKeyHint;
      }
      existing.pendingSpawns = Math.min(existing.pendingSpawns + spawnMultiplier, spawnMultiplier * 3);
      return false;
    }
    const entry = {
      key,
      tileX,
      tileY,
      lineKeyHint: lineKeyHint ?? null,
      cooldown: 0,
      attempts: 0,
      pendingSpawns: spawnMultiplier
    };
    this.pendingSpawns.set(key, entry);
    this.pendingSpawnOrder.push(key);
    return true;
  }

  _processDeferredSpawns(dt) {
    if (!this.spawningEnabled) {
      return;
    }

    for (const key of this.pendingSpawnOrder) {
      const entry = this.pendingSpawns.get(key);
      if (entry && entry.cooldown > 0) {
        entry.cooldown = Math.max(0, entry.cooldown - dt);
      }
    }

    this._drainPendingTiles();
    this._processRoadLines(1);

    if (!this.pendingSpawnOrder.length) {
      return;
    }

    const playerTile = this._getPlayerTile();
    if (this.globalSpawnCooldown > 0) {
      this.globalSpawnCooldown = Math.max(0, this.globalSpawnCooldown - dt);
      if (this.globalSpawnCooldown > 0) {
        return;
      }
    }
    if (this.spawnFallbackCooldown > 0) {
      this.spawnFallbackCooldown = Math.max(0, this.spawnFallbackCooldown - dt);
    }

    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();
    const startTime = now();
    const timeBudgetMs = Math.max(1, dt * 1000 * this.spawnTimeRatio);

    const maxChecks = Math.min(this.pendingSpawnOrder.length, this.MAX_PENDING_CHECKS);
    let checks = 0;
    let spawned = 0;

    while (this.pendingSpawnOrder.length > 0 && checks < maxChecks && spawned < this.MAX_SPAWNS_PER_TICK) {
      let selectedIndex = -1;
      let bestDistance = Infinity;

      for (let i = 0; i < this.pendingSpawnOrder.length; i += 1) {
        const key = this.pendingSpawnOrder[i];
        const entry = this.pendingSpawns.get(key);
        if (!entry) {
          this.pendingSpawnOrder.splice(i, 1);
          i -= 1;
          continue;
        }
        if (entry.cooldown > 0) {
          continue;
        }
        if (playerTile && !this._isTileWithinPlayerChunks(entry.tileX, entry.tileY, playerTile)) {
          continue;
        }
        if (!playerTile) {
          selectedIndex = i;
          break;
        }
        const distance = Math.hypot(entry.tileX - playerTile.x, entry.tileY - playerTile.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          selectedIndex = i;
        }
      }

      if (selectedIndex === -1) {
        break;
      }

      const key = this.pendingSpawnOrder[selectedIndex];
      const entry = this.pendingSpawns.get(key);
      if (!entry) {
        this.pendingSpawnOrder.splice(selectedIndex, 1);
        continue;
      }

      checks += 1;

      if (entry.cooldown > 0) {
        continue;
      }
      if (playerTile && !this._isTileWithinPlayerChunks(entry.tileX, entry.tileY, playerTile)) {
        entry.cooldown = Math.max(entry.cooldown, 1);
        continue;
      }

      const result = this._attemptDeferredSpawn(entry);
      if (result === "continue") {
        spawned += 1;
        this.globalSpawnCooldown = Math.max(this.globalSpawnCooldown, 1);
        continue;
      }
      if (result === "success" || result === "discard") {
        this.pendingSpawns.delete(key);
        this.pendingSpawnOrder.splice(selectedIndex, 1);
        if (result === "success") {
          spawned += 1;
          this.globalSpawnCooldown = Math.max(this.globalSpawnCooldown, 1);
        }
        continue;
      }

      if (result === "retry_long") {
        entry.cooldown = Math.max(entry.cooldown, 1.5);
      } else {
        entry.cooldown = Math.max(entry.cooldown, 0.5);
      }

      if (now() - startTime >= timeBudgetMs) {
        break;
      }
    }
  }

  _enqueueRoadLine(axis, coord) {
    if (!axis || !Number.isFinite(coord)) {
      return;
    }
    this.pendingRoadLines.push({ axis, coord: Math.trunc(coord) });
  }

  _processRoadLines(maxLines = 2) {
    let processed = 0;
    while (this.pendingRoadLines.length > 0 && processed < maxLines) {
      const { axis, coord } = this.pendingRoadLines.shift();
      this._handleRoadLine(axis, coord);
      processed += 1;
    }
  }

  _drainPendingTiles(maxTiles = 16) {
    if (!this.spawningEnabled || !this.pendingTileRequests.length) {
      return;
    }
    let processed = 0;
    while (this.pendingTileRequests.length > 0 && processed < maxTiles) {
      const request = this.pendingTileRequests.shift();
      if (request && Number.isFinite(request.tileX) && Number.isFinite(request.tileY)) {
        this._queueSpawn(request.tileX, request.tileY, null);
        processed += 1;
      }
    }
  }

  _handleRoadLine(axis, coord) {
    if (!axis || !Number.isFinite(coord)) {
      return;
    }
    const key = `${axis}:${Math.trunc(coord)}`;
    if (this.spawnedLines.has(key)) {
      return;
    }
    this.spawnedLines.add(key);

    const tiles = this._gatherLineTiles(axis, Math.trunc(coord));
    if (!tiles.length) {
      return;
    }

    const spawnCount = Math.min(this.TRAFFIC_PER_ROAD * 2, tiles.length);
    for (let index = 0; index < spawnCount; index += 1) {
      const t = (index + 0.5) / spawnCount;
      const tileIndex = Math.min(tiles.length - 1, Math.max(0, Math.floor(t * tiles.length)));
      const tile = tiles[tileIndex];
      this._queueSpawn(tile.x, tile.y, key);
    }
  }

  _attemptDeferredSpawn(entry) {
    const resolved = this._resolveSpawnTile(entry.tileX, entry.tileY);
    if (!resolved) {
      entry.attempts = (entry.attempts || 0) + 1;
      return entry.attempts >= this.MAX_DEFERRED_ATTEMPTS ? "discard" : "retry_short";
    }

    const dirKey = this._chooseInitialDirection(resolved.x, resolved.y);
    if (!dirKey) {
      return "discard";
    }

    const lineKey = this._lineKeyFor(resolved.x, resolved.y, dirKey) || entry.lineKeyHint || null;
    if (lineKey) {
      entry.lineKeyHint = lineKey;
      if (this._countVehiclesOnLine(lineKey) >= this._lineLimitForTile(resolved.x, resolved.y)) {
        return "retry_long";
      }
    }

    const candidates = this._buildCandidates();
    if (!candidates || candidates.length === 0) {
      return "retry_long";
    }

    const carSpec = candidates[Math.floor(Math.random() * candidates.length)];
    const spawned = this._spawnVehicleAt(resolved.x, resolved.y, carSpec, dirKey, lineKey);
    if (spawned) {
      if (lineKey) {
        this._trimLineToLimit(lineKey, resolved.x, resolved.y);
      }
      entry.pendingSpawns = Math.max(0, (entry.pendingSpawns || 1) - 1);
      if (entry.pendingSpawns > 0) {
        entry.cooldown = Math.max(entry.cooldown, 0.25);
        entry.lineKeyHint = lineKey;
        return "continue";
      }
      return "success";
    }

    entry.attempts = (entry.attempts || 0) + 1;
    return entry.attempts >= this.MAX_DEFERRED_ATTEMPTS ? "discard" : "retry_short";
  }

  _spawnFallback(requestedCount) {
    const roadKeys = typeof this.level.getRandomRoadKeys === "function"
      ? this.level.getRandomRoadKeys(requestedCount * 4)
      : Array.from(this.level.roadTiles.keys());
    if (!roadKeys.length) {
      return;
    }
    const count = Math.min(this.TRAFFIC_PER_ROAD * 2, Math.max(1, Math.min(requestedCount, roadKeys.length)));
    const used = new Set();
    let queued = 0;
    let attempts = 0;
    const maxAttempts = roadKeys.length * 3;
    while (queued < count && attempts < maxAttempts) {
      attempts += 1;
      const key = roadKeys[Math.floor(Math.random() * roadKeys.length)];
      if (used.has(key)) {
        continue;
      }
      used.add(key);
      const [txStr, tyStr] = key.split(",");
      const tileX = Number(txStr);
      const tileY = Number(tyStr);
      if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
        continue;
      }
      if (this._queueSpawn(tileX, tileY, null)) {
        queued += 1;
      }
    }
  }

  spawnAtRoadTile(tileX, tileY) {
    if (!this.enabled || !this.spawningEnabled) {
      this.pendingTileRequests.push({ tileX, tileY });
      return false;
    }
    return this._queueSpawn(tileX, tileY, null);
  }

  _gatherLineTiles(axis, coord) {
    if (this.level && typeof this.level.getLineTiles === "function") {
      const tiles = this.level.getLineTiles(axis, coord);
      if (tiles && tiles.length) {
        return tiles;
      }
    }
    const tiles = [];
    for (const key of this.level.roadTiles.keys()) {
      const [txStr, tyStr] = key.split(",");
      const tx = Number(txStr);
      const ty = Number(tyStr);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        continue;
      }
      if (axis === "H" && ty === coord) {
        tiles.push({ x: tx, y: ty });
      } else if (axis === "V" && tx === coord) {
        tiles.push({ x: tx, y: ty });
      }
    }
    if (axis === "H") {
      tiles.sort((a, b) => a.x - b.x);
    } else {
      tiles.sort((a, b) => a.y - b.y);
    }
    return tiles;
  }

  _tileCenter(tileX, tileY) {
    return {
      x: tileX * TILE_SIZE + TILE_SIZE / 2,
      y: tileY * TILE_SIZE + TILE_SIZE / 2
    };
  }

  _tileLaneTarget(tileX, tileY, dirKey) {
    const baseX = tileX * TILE_SIZE;
    const baseY = tileY * TILE_SIZE;
    const centerX = baseX + TILE_SIZE * 0.5;
    const centerY = baseY + TILE_SIZE * 0.5;
    const nearEdge = TILE_SIZE * 0.25;
    const farEdge = TILE_SIZE * 0.75;
    switch (dirKey) {
      case "E":
        return { x: centerX, y: baseY + farEdge };
      case "W":
        return { x: centerX, y: baseY + nearEdge };
      case "N":
        return { x: baseX + farEdge, y: centerY };
      case "S":
        return { x: baseX + nearEdge, y: centerY };
      default:
        return { x: centerX, y: centerY };
    }
  }

  _classifyTurn(fromDir, toDir) {
    const fromIdx = DIR_TO_INDEX[fromDir];
    const toIdx = DIR_TO_INDEX[toDir];
    if (fromIdx == null || toIdx == null) {
      return null;
    }
    const delta = (toIdx - fromIdx + 4) % 4;
    if (delta === 0) {
      return null;
    }
    if (delta === 1) {
      return "right";
    }
    if (delta === 2) {
      return "uturn";
    }
    if (delta === 3) {
      return "left";
    }
    return null;
  }

  _configureTurnArc(state, fromDir, toDir) {
    if (!state) {
      return;
    }
    const turnType = this._classifyTurn(fromDir, toDir);
    if (!turnType) {
      this._clearTurnArc(state);
      return;
    }
    const startPoint = this._tileLaneTarget(state.currentTileX, state.currentTileY, fromDir);
    const endPoint = this._tileLaneTarget(state.targetTileX, state.targetTileY, toDir);
    const arcPoints = this._buildTurnArcPoints(startPoint, endPoint, fromDir, toDir, turnType, state);
    if (arcPoints && arcPoints.length) {
      state.turnArc = arcPoints;
      state.turnArcIndex = 0;
    } else {
      this._clearTurnArc(state);
    }
  }

  _clearTurnArc(state) {
    if (!state) {
      return;
    }
    state.turnArc = null;
    state.turnArcIndex = 0;
  }

  _currentTurnArcTarget(state) {
    if (!state || !state.turnArc) {
      return null;
    }
    if (state.turnArcIndex == null || state.turnArcIndex >= state.turnArc.length) {
      return null;
    }
    return state.turnArc[state.turnArcIndex];
  }

  _buildTurnArcPoints(startPoint, endPoint, fromDir, toDir, turnType, state) {
    const bezier = this._buildBezierTurnPath(startPoint, endPoint, fromDir, toDir, turnType);
    if (bezier && bezier.length) {
      return bezier;
    }
    return this._buildIntersectionTurnTargets(state, fromDir, toDir, turnType);
  }

  _buildBezierTurnPath(startPoint, endPoint, fromDir, toDir, turnType) {
    const fromVec = this._directionVector(fromDir);
    const toVec = this._directionVector(toDir);
    if (!fromVec || !toVec) {
      return null;
    }
    const controlScale = turnType === "uturn" ? TILE_SIZE * 0.9 : TILE_SIZE * 0.55;
    const control1 = {
      x: startPoint.x + fromVec.dx * controlScale,
      y: startPoint.y + fromVec.dy * controlScale
    };
    const control2 = {
      x: endPoint.x - toVec.dx * controlScale,
      y: endPoint.y - toVec.dy * controlScale
    };
    const segments = turnType === "uturn" ? 10 : 6;
    return this._sampleBezierPoints(startPoint, control1, control2, endPoint, segments);
  }

  _sampleBezierPoints(p0, p1, p2, p3, segments = 6) {
    if (!Number.isFinite(segments) || segments <= 0) {
      return null;
    }
    const points = [];
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments;
      const invT = 1 - t;
      const x =
        invT ** 3 * p0.x +
        3 * invT * invT * t * p1.x +
        3 * invT * t * t * p2.x +
        t ** 3 * p3.x;
      const y =
        invT ** 3 * p0.y +
        3 * invT * invT * t * p1.y +
        3 * invT * t * t * p2.y +
        t ** 3 * p3.y;
      points.push({ x, y });
    }
    return points;
  }

  _buildIntersectionTurnTargets(state, fromDir, toDir, turnType) {
    const tileX = Number.isFinite(state?.targetTileX) ? state.targetTileX : null;
    const tileY = Number.isFinite(state?.targetTileY) ? state.targetTileY : null;
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      return null;
    }
    const tileCenter = this._intersectionCenter(tileX, tileY);
    if (turnType === "left") {
      return [tileCenter];
    }
    if (turnType === "right") {
      const corner = this._intersectionCorner(tileX, tileY, fromDir, toDir);
      return corner ? [corner] : null;
    }
    return null;
  }

  _intersectionCenter(tileX, tileY) {
    const baseX = tileX * TILE_SIZE;
    const baseY = tileY * TILE_SIZE;
    return {
      x: baseX + TILE_SIZE * 0.5,
      y: baseY + TILE_SIZE * 0.5
    };
  }

  _intersectionCorner(tileX, tileY, fromDir, toDir) {
    const baseX = tileX * TILE_SIZE;
    const baseY = tileY * TILE_SIZE;
    const padding = TILE_SIZE * 0.2;
    const corners = {
      NE: { x: baseX + TILE_SIZE - padding, y: baseY + padding },
      NW: { x: baseX + padding, y: baseY + padding },
      SE: { x: baseX + TILE_SIZE - padding, y: baseY + TILE_SIZE - padding },
      SW: { x: baseX + padding, y: baseY + TILE_SIZE - padding }
    };
    const insideKey = this._rightTurnCorner(fromDir, toDir);
    return insideKey ? corners[insideKey] ?? null : null;
  }

  _rightTurnCorner(fromDir, toDir) {
    if (fromDir === "N" && toDir === "E") return "NE";
    if (fromDir === "E" && toDir === "S") return "SE";
    if (fromDir === "S" && toDir === "W") return "SW";
    if (fromDir === "W" && toDir === "N") return "NW";
    return null;
  }

  _turnRadius(turnType) {
    switch (turnType) {
      case "right":
        return TURN_RADIUS_RIGHT;
      case "left":
        return TURN_RADIUS_LEFT;
      case "uturn":
        return TURN_RADIUS_UTURN;
      default:
        return null;
    }
  }

  _turnArcSegments(turnType) {
    return TURN_SEGMENTS[turnType] ?? 6;
  }

  _turnOrientation(turnType, _fromDir) {
    if (turnType === "right") {
      return "cw";
    }
    if (turnType === "left") {
      return "ccw";
    }
    if (turnType === "uturn") {
      return "cw";
    }
    return null;
  }

  _directionVector(dirKey) {
    const entry = TRAFFIC_DIRECTIONS[dirKey];
    if (!entry) {
      return null;
    }
    return { x: entry.dx, y: entry.dy, dx: entry.dx, dy: entry.dy };
  }

  _rotateLeft(vec) {
    return { x: -vec.y, y: vec.x };
  }

  _rotateRight(vec) {
    return { x: vec.y, y: -vec.x };
  }

  _findNearestCollisionObstacle(entry, position) {
    if (!position) {
      return null;
    }
    let best = null;
    const consider = (x, y, type) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const dx = position.x - x;
      const dy = position.y - y;
      const distance = Math.hypot(dx, dy);
      if (!Number.isFinite(distance)) {
        return;
      }
      if (!best || distance < best.distance) {
        best = { x, y, distance, type };
      }
    };

    const veh = entry?.veh;
    const tileX = Math.floor(position.x / TILE_SIZE);
    const tileY = Math.floor(position.y / TILE_SIZE);
    const buildings = this.level?.buildingTiles;
    if (buildings && typeof buildings.has === "function") {
      const searchRadius = 2;
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
          const tx = tileX + dx;
          const ty = tileY + dy;
          const key = this.level.tileKey(tx, ty);
          if (!buildings.has(key)) {
            continue;
          }
          const centerX = tx * TILE_SIZE + TILE_SIZE / 2;
          const centerY = ty * TILE_SIZE + TILE_SIZE / 2;
          consider(centerX, centerY, "building");
        }
      }
    }

    if (Array.isArray(this.vehicles)) {
      for (const other of this.vehicles) {
        if (!other || other === entry) {
          continue;
        }
        const otherVeh = other.veh;
        if (!otherVeh || otherVeh === veh || typeof otherVeh.getPosition !== "function") {
          continue;
        }
        const otherPos = otherVeh.getPosition();
        if (!otherPos) {
          continue;
        }
        consider(otherPos.x, otherPos.y, "vehicle");
      }
    }

    const playerBody = this.playerVehicle?.body;
    if (playerBody && Number.isFinite(playerBody.x) && Number.isFinite(playerBody.y)) {
      consider(playerBody.x, playerBody.y, "player");
    }

    return best;
  }

  _hasOtherVehicleOnTile(vehicle, tileX, tileY) {
    for (const entry of this.vehicles) {
      const otherVeh = entry?.veh;
      if (!otherVeh || otherVeh === vehicle) {
        continue;
      }
      const otherPos = otherVeh.getPosition();
      const ox = Math.floor(otherPos.x / TILE_SIZE);
      const oy = Math.floor(otherPos.y / TILE_SIZE);
      if (ox === tileX && oy === tileY) {
        return true;
      }
    }
    return false;
  }

  _distanceToTargetBoundary(position, state) {
    const dirKey = state?.dir;
    if (!dirKey || !Number.isFinite(state.targetTileX) || !Number.isFinite(state.targetTileY)) {
      return Infinity;
    }
    switch (dirKey) {
      case "E": {
        const boundary = state.targetTileX * TILE_SIZE;
        return Math.max(0, boundary - position.x);
      }
      case "W": {
        const boundary = (state.targetTileX + 1) * TILE_SIZE;
        return Math.max(0, position.x - boundary);
      }
      case "S": {
        const boundary = state.targetTileY * TILE_SIZE;
        return Math.max(0, boundary - position.y);
      }
      case "N": {
        const boundary = (state.targetTileY + 1) * TILE_SIZE;
        return Math.max(0, position.y - boundary);
      }
      default:
        return Infinity;
    }
  }

  _processRecovery(entry, position, dt, bounds) {
    const state = entry.state;
    if (!state.recovering || !state.recoveryTargetWorld) {
      state.recovering = false;
      state.recoveryDriveMode = null;
      state.reverseDrivingTimer = 0;
      return true;
    }
    const veh = entry.veh;
    const target = state.recoveryTargetWorld;
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const distance = Math.hypot(dx, dy);
    const driveMode = state.recoveryDriveMode === "forward" ? "forward" : "reverse";
    const forwardHeading = Math.atan2(dy, dx);
    const reverseHeading = normalizeAngle(forwardHeading + Math.PI);
    const desiredHeading = driveMode === "forward" ? forwardHeading : reverseHeading;
    const angleDiff = normalizeAngle(desiredHeading - veh.physics.heading);

    const input = {
      forward: false,
      reverse: false,
      left: angleDiff < -0.05,
      right: angleDiff > 0.05,
      brake: false
    };

    const turnSpeed = 5 * MPH_TO_METERS_PER_SECOND;
    const currentSpeed = veh.physics.getSpeedMetersPerSecond();
    if (currentSpeed > turnSpeed + 0.5) {
      input.brake = true;
    } else if (currentSpeed < turnSpeed - 0.5) {
      if (driveMode === "forward") {
        input.forward = true;
      } else {
        input.reverse = true;
      }
    } else {
      if (driveMode === "forward") {
        input.forward = true;
      } else {
        input.reverse = true;
      }
    }

    const longitudinalBeforeUpdate = this._readLongitudinalSpeed(veh);

    veh.update(input, dt, bounds);
    state.lastLongitudinalSpeed = longitudinalBeforeUpdate;
    this._applyReverseBreaker(entry, dt);
    this._updateLineTargetTimer(entry, dt);

    const nextPosition = veh.getPosition();
    const remaining = Math.hypot(target.x - nextPosition.x, target.y - nextPosition.y);
    const arrivalThreshold = Math.max(4, TILE_SIZE * 0.1);
    if (remaining <= arrivalThreshold) {
      const finalTile = state.recoveryFinalTile;
      if (finalTile) {
        state.currentTileX = finalTile.x;
        state.currentTileY = finalTile.y;
        state.targetTileX = finalTile.x;
        state.targetTileY = finalTile.y;
      }
      const dir =
        state.recoveryDir ??
        state.dir ??
        this._chooseInitialDirection(state.currentTileX, state.currentTileY);
      if (dir) {
        state.dir = dir;
        state.lineKey = this._lineKeyFor(state.currentTileX, state.currentTileY, dir);
        state.pendingLineKey = null;
        const laneTarget =
          state.recoveryLaneTarget ??
          this._tileLaneTarget(state.currentTileX, state.currentTileY, dir);
        state.targetWorld = laneTarget;
      }
      state.recovering = false;
      state.recoveryTargetWorld = null;
      state.recoveryFinalTile = null;
      state.recoveryDir = null;
      state.recoveryLaneTarget = null;
      state.turnCommitArmed = false;
      state.turning = false;
      state.recoveryDriveMode = null;
      state.reverseDrivingTimer = 0;
      this._clearTurnArc(state);
      veh.physics.stop();
      if (!this._assignNextTarget(entry, true)) {
        this._assignNextTarget(entry, false);
      }
    }
    return true;
  }

  _startCollisionRecovery(entry, position) {
    const state = entry.state;
    if (!entry?.veh) {
      return;
    }
    const obstacle = this._findNearestCollisionObstacle(entry, position);
    let dirX = 0;
    let dirY = 0;
    const retreatDistance = TILE_SIZE * 0.25;
    if (obstacle && obstacle.distance > 0.001) {
      dirX = position.x - obstacle.x;
      dirY = position.y - obstacle.y;
      const length = Math.hypot(dirX, dirY);
      if (length > 1e-4) {
        dirX /= length;
        dirY /= length;
      } else {
        dirX = 0;
        dirY = 0;
      }
    }
    if (dirX === 0 && dirY === 0) {
      const heading = entry.veh.physics.heading;
      dirX = -Math.cos(heading);
      dirY = -Math.sin(heading);
    }
    const movementLength = Math.hypot(dirX, dirY);
    if (movementLength > 1e-4) {
      dirX /= movementLength;
      dirY /= movementLength;
    } else {
      dirX = -Math.cos(entry.veh.physics.heading);
      dirY = -Math.sin(entry.veh.physics.heading);
    }
    const target = {
      x: position.x + dirX * retreatDistance,
      y: position.y + dirY * retreatDistance
    };
    const headingVec = {
      x: Math.cos(entry.veh.physics.heading),
      y: Math.sin(entry.veh.physics.heading)
    };
    const movementDot = dirX * headingVec.x + dirY * headingVec.y;
    state.recoveryDriveMode = movementDot >= 0 ? "forward" : "reverse";
    state.reverseDrivingTimer = 0;
    const finalTile = {
      x: state.currentTileX,
      y: state.currentTileY
    };
    state.recovering = true;
    state.recoveryTargetWorld = target;
    state.recoveryFinalTile = finalTile;
    state.recoveryDir = state.dir ?? null;
    state.recoveryLaneTarget = state.targetWorld ?? null;
    state.turnCommitArmed = false;
    state.turning = false;
    this._clearTurnArc(state);
  }

  _applyReverseBreaker(entry, dt) {
    const state = entry?.state;
    const veh = entry?.veh;
    if (!state || !veh?.physics) {
      return;
    }
    if (veh.physics.reverseMode) {
      state.reverseDrivingTimer = (state.reverseDrivingTimer || 0) + dt;
      if (state.reverseDrivingTimer >= 2) {
        state.reverseDrivingTimer = 0;
        veh.physics.reverseMode = false;
        const gearRatios = Array.isArray(veh.physics.config?.gearRatios)
          ? veh.physics.config.gearRatios
          : [];
        if (gearRatios.length > 1) {
          veh.physics.gearIndex = Math.min(1, gearRatios.length - 1);
        } else {
          veh.physics.gearIndex = 0;
        }
        if (state.recoveryDriveMode === "reverse") {
          state.recoveryDriveMode = "forward";
        }
      }
    } else {
      state.reverseDrivingTimer = 0;
    }
  }

  _updateLineTargetTimer(entry, dt) {
    const state = entry?.state;
    if (!state) {
      return;
    }
    if (state.lineKey) {
      state.lineTargetLostTime = 0;
      return;
    }
    state.lineTargetLostTime = (state.lineTargetLostTime || 0) + dt;
    if (state.lineTargetLostTime >= LINE_TARGET_TIMEOUT) {
      if (this._redirectToNearestLine(entry)) {
        state.lineTargetLostTime = 0;
      } else {
        state.lineTargetLostTime = LINE_TARGET_TIMEOUT;
      }
    }
  }

  _redirectToNearestLine(entry) {
    const state = entry?.state;
    if (!state || !this.level) {
      return false;
    }
    const applyLine = (tileX, tileY, dir) => {
      if (!Number.isFinite(tileX) || !Number.isFinite(tileY) || !dir) {
        return false;
      }
      const lineKey = this._lineKeyFor(tileX, tileY, dir);
      if (!lineKey) {
        return false;
      }
      state.lineKey = lineKey;
      state.pendingLineKey = null;
      if (!state.dir) {
        state.dir = dir;
      }
      if (!Number.isFinite(state.targetTileX) || !Number.isFinite(state.targetTileY)) {
        state.targetTileX = tileX;
        state.targetTileY = tileY;
      }
      if (!state.targetWorld) {
        state.targetWorld = this._tileLaneTarget(tileX, tileY, dir);
      }
      state.lineTargetLostTime = 0;
      this._assignNextTarget(entry, true);
      return true;
    };

    const dir = state.dir ?? this._chooseInitialDirection(state.currentTileX, state.currentTileY);
    if (applyLine(state.currentTileX, state.currentTileY, dir)) {
      return true;
    }

    const fallback = this._findNearestRoadTile(state.currentTileX, state.currentTileY, 4);
    if (fallback) {
      const fallbackDir = this._chooseInitialDirection(fallback.x, fallback.y) ?? state.dir;
      if (applyLine(fallback.x, fallback.y, fallbackDir)) {
        state.currentTileX = fallback.x;
        state.currentTileY = fallback.y;
        return true;
      }
    }
    return false;
  }

  _finalizeTurnArrival(entry, state) {
    if (!state) {
      return false;
    }
    state.currentTileX = state.targetTileX;
    state.currentTileY = state.targetTileY;
    const arrivedTile = this.level?.getTile(state.currentTileX, state.currentTileY);
    if (state.pendingLineKey != null && (!arrivedTile || arrivedTile.code === "I")) {
      state.lineKey = state.pendingLineKey;
      state.pendingLineKey = null;
    }
    if (!this._isRoadTile(state.currentTileX, state.currentTileY)) {
      return false;
    }
    if (!this._assignNextTarget(entry, false) && !this._assignNextTarget(entry, true)) {
      return false;
    }
    return true;
  }

  _readLongitudinalSpeed(vehicle) {
    if (!vehicle?.physics || typeof vehicle.physics.getLongitudinalSpeed !== "function") {
      return 0;
    }
    try {
      const value = vehicle.physics.getLongitudinalSpeed();
      return Number.isFinite(value) ? value : 0;
    } catch (_error) {
      return 0;
    }
  }

  _getRoadEntry(tileX, tileY) {
    return this.level.roadTiles.get(`${tileX},${tileY}`) ?? null;
  }

  _isRoadTile(tileX, tileY) {
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      return false;
    }
    if (this._getRoadEntry(tileX, tileY)) {
      return true;
    }
    const cache = this.level?.tileCache;
    if (cache && cache.has(`${tileX},${tileY}`)) {
      const tile = cache.get(`${tileX},${tileY}`);
      return Boolean(tile && ROAD_TILE_CODES.has(tile.code));
    }
    return false;
  }

  _chooseInitialDirection(tileX, tileY) {
    const entry = this._getRoadEntry(tileX, tileY);
    if (!entry) {
      return null;
    }
    const options = Array.from(entry.connections ?? []);
    if (!options.length) {
      return null;
    }
    const shuffled = options.slice().sort(() => Math.random() - 0.5);
    for (const dirKey of shuffled) {
      const vec = TRAFFIC_DIRECTIONS[dirKey];
      if (!vec) {
        continue;
      }
      const nextX = tileX + vec.dx;
      const nextY = tileY + vec.dy;
      if (this._isRoadTile(nextX, nextY)) {
        return dirKey;
      }
    }
    return null;
  }

  _spawnVehicleAt(tileX, tileY, carSpec, dirKey, explicitLineKey = null) {
    const dir = TRAFFIC_DIRECTIONS[dirKey];
    if (!dir) {
      return null;
    }
    const lineKey = explicitLineKey ?? this._lineKeyFor(tileX, tileY, dirKey);
    if (lineKey && this._countVehiclesOnLine(lineKey) >= this._lineLimitForTile(tileX, tileY)) {
      return null;
    }
    if (this._hasVehicleOnTile(tileX, tileY)) {
      return null;
    }
    const position = this._tileLaneTarget(tileX, tileY, dirKey);
    const config = createCarConfigFromSpec(carSpec?.specs ?? {}, { carId: carSpec?.id });
    const vehicle = new Vehicle(
      this.system,
      { x: position.x, y: position.y, angle: dir.angle },
      config,
      carSpec,
      { precomputedConfig: true, level: this }
    );
    vehicle.physics.setWorldPosition(position.x, position.y);
    vehicle.body.setPosition(position.x, position.y);
    vehicle.body.setAngle(dir.angle);
    vehicle.physics.heading = dir.angle;
    vehicle.reset({ preserveCollisions: true });

    const entry = {
      veh: vehicle,
      state: {
        currentTileX: tileX,
        currentTileY: tileY,
        dir: dirKey,
        targetTileX: tileX,
        targetTileY: tileY,
        targetWorld: null,
        turning: false,
        lineKey,
        pendingLineKey: null,
        turnCommitArmed: false,
        recovering: false,
        recoveryTargetWorld: null,
        recoveryFinalTile: null,
        recoveryDir: null,
        recoveryLaneTarget: null,
        lastCollisionCount: vehicle.collisions ?? 0,
        lastLongitudinalSpeed: 0,
        turnArc: null,
        turnArcIndex: 0,
        recoveryDriveMode: null,
        reverseDrivingTimer: 0,
        lineTargetLostTime: 0
      }
    };

    if (!this._assignNextTarget(entry, true)) {
      try {
        if (vehicle?.body && typeof this.system.remove === "function") {
          this.system.remove(vehicle.body);
        }
      } catch (_error) {}
      return null;
    }

    this.vehicles.push(entry);
    return entry;
  }

  _lineKeyFor(tileX, tileY, dirKey) {
    switch (dirKey) {
      case "E":
      case "W":
        return `H:${tileY}`;
      case "N":
      case "S":
        return `V:${tileX}`;
      default:
        return null;
    }
  }

  _findNearestRoadTile(tileX, tileY, radius = 3) {
    let best = null;
    let bestDist = Infinity;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const nx = tileX + dx;
        const ny = tileY + dy;
        if (!this._isRoadTile(nx, ny)) {
          continue;
        }
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: nx, y: ny };
        }
      }
    }
    return best;
  }

  _assignNextTarget(entry, allowReverse = false) {
    const state = entry.state;
    const currentTileX = state.currentTileX;
    const currentTileY = state.currentTileY;
    const roadEntry = this._getRoadEntry(currentTileX, currentTileY);
    if (!roadEntry) {
      return false;
    }
    const connections = Array.from(roadEntry.connections ?? []);
    if (!connections.length) {
      return false;
    }

    const valid = connections.filter((dirKey) => {
      const vec = TRAFFIC_DIRECTIONS[dirKey];
      if (!vec) {
        return false;
      }
      const nextX = currentTileX + vec.dx;
      const nextY = currentTileY + vec.dy;
      return this._isRoadTile(nextX, nextY);
    });

    let pool = valid.length ? valid : connections;
    const reverse = state.dir ? oppositeDirection(state.dir) : null;
    if (reverse) {
      const hasNonReverseOption = pool.some((dirKey) => dirKey !== reverse);
      if (hasNonReverseOption) {
        pool = pool.filter((dirKey) => dirKey !== reverse);
      } else if (!allowReverse) {
        return false;
      }
    }

    if (!pool.length) {
      return false;
    }

    const previousDir = state.dir ?? null;
    const nextDir = pool[Math.floor(Math.random() * pool.length)];
    const vec = TRAFFIC_DIRECTIONS[nextDir];
    state.turning = false;
    state.dir = nextDir;
    state.targetTileX = currentTileX + vec.dx;
    state.targetTileY = currentTileY + vec.dy;
    state.targetWorld = this._tileLaneTarget(state.targetTileX, state.targetTileY, nextDir);
    const nextLineKey = this._lineKeyFor(state.targetTileX, state.targetTileY, nextDir);
    const nextTileDef = this.level?.getTile(state.targetTileX, state.targetTileY);
    if (nextTileDef?.code === "I") {
      state.pendingLineKey = nextLineKey;
    } else {
      state.lineKey = nextLineKey;
      state.pendingLineKey = null;
    }
    state.turnCommitArmed = false;
    this._clearTurnArc(state);
    return true;
  }

  _updateVehicle(entry, dt, bounds) {
    const veh = entry.veh;
    const state = entry.state;

    if (!state.targetWorld) {
      if (!this._assignNextTarget(entry, true)) {
        return false;
      }
    }

    const position = veh.getPosition();
    const tileX = Math.floor(position.x / TILE_SIZE);
    const tileY = Math.floor(position.y / TILE_SIZE);

    const collisionCount = veh.collisions ?? 0;
    if (typeof state.lastCollisionCount !== "number") {
      state.lastCollisionCount = collisionCount;
    }
    const priorLongitudinalSpeed = Number.isFinite(state.lastLongitudinalSpeed)
      ? state.lastLongitudinalSpeed
      : 0;
    const wasMovingForward =
      priorLongitudinalSpeed > COLLISION_FORWARD_SPEED_THRESHOLD;
    if (collisionCount > state.lastCollisionCount) {
      if (!state.recovering && wasMovingForward) {
        this._startCollisionRecovery(entry, position);
      }
      this._redirectToNearestLine(entry);
    }
    state.lastCollisionCount = collisionCount;

    const tileKey = this.level.tileKey(tileX, tileY);
    const onBuildingTile =
      this.level.buildingTiles && typeof this.level.buildingTiles.has === "function"
        ? this.level.buildingTiles.has(tileKey)
        : false;

    if (!this._isRoadTile(tileX, tileY)) {
      if (onBuildingTile) {
        if (!state.recovering) {
          const fallback = this._findNearestRoadTile(tileX, tileY, 3);
          if (fallback) {
            const preferredDir =
              state.dir ?? this._chooseInitialDirection(fallback.x, fallback.y);
            const laneDir = preferredDir ?? "N";
            const laneTarget = this._tileLaneTarget(fallback.x, fallback.y, laneDir);
            const dx = laneTarget.x - position.x;
            const dy = laneTarget.y - position.y;
            const dist = Math.hypot(dx, dy);
            const maxStep = TILE_SIZE / 2;
            let recoveryTarget;
            if (dist > 0) {
              const scale = dist > maxStep ? maxStep / dist : 1;
              recoveryTarget = {
                x: position.x + dx * scale,
                y: position.y + dy * scale
              };
            } else {
              recoveryTarget = { ...laneTarget };
            }
            state.recovering = true;
            state.recoveryTargetWorld = recoveryTarget;
            state.recoveryFinalTile = fallback;
            state.recoveryDir = laneDir;
            state.recoveryLaneTarget = laneTarget;
            state.turnCommitArmed = false;
            state.turning = false;
            const moveLen = Math.hypot(recoveryTarget.x - position.x, recoveryTarget.y - position.y);
            if (moveLen > 1e-4 && entry?.veh?.physics) {
              const moveX = (recoveryTarget.x - position.x) / moveLen;
              const moveY = (recoveryTarget.y - position.y) / moveLen;
              const headingVec = {
                x: Math.cos(entry.veh.physics.heading),
                y: Math.sin(entry.veh.physics.heading)
              };
              const dot = moveX * headingVec.x + moveY * headingVec.y;
              state.recoveryDriveMode = dot >= 0 ? "forward" : "reverse";
            } else {
              state.recoveryDriveMode = "forward";
            }
            this._clearTurnArc(state);
          }
        }
      } else {
        const fallback = this._findNearestRoadTile(tileX, tileY, 3);
        if (fallback) {
          state.currentTileX = fallback.x;
          state.currentTileY = fallback.y;
          if (!state.dir) {
            const dir = this._chooseInitialDirection(fallback.x, fallback.y);
            if (dir) {
              state.dir = dir;
          state.lineKey = this._lineKeyFor(fallback.x, fallback.y, dir);
          state.pendingLineKey = null;
            }
          }
          state.targetTileX = fallback.x;
          state.targetTileY = fallback.y;
          state.targetWorld = this._tileLaneTarget(fallback.x, fallback.y, state.dir);
          this._assignNextTarget(entry, true);
        }
      }
    } else {
      state.currentTileX = tileX;
      state.currentTileY = tileY;
    }

    if (state.recovering) {
      return this._processRecovery(entry, position, dt, bounds);
    }

    if (!state.dir) {
      const dir = this._chooseInitialDirection(state.currentTileX, state.currentTileY);
      if (dir) {
        state.dir = dir;
        state.lineKey = this._lineKeyFor(state.currentTileX, state.currentTileY, dir);
        state.pendingLineKey = null;
        state.targetWorld = this._tileLaneTarget(state.currentTileX, state.currentTileY, state.dir);
        this._assignNextTarget(entry, true);
      }
    }

    const analyzeUpcoming = () => {
      const nextTileX = state.targetTileX;
      const nextTileY = state.targetTileY;
      const nextTile = this.level.getTile(nextTileX, nextTileY);
      const nextEntry = this._getRoadEntry(nextTileX, nextTileY);
      const result = {
        intersection: false,
        deadEnd: false,
        stepsUntilStop: Infinity
      };
      const nextConnections = nextEntry?.connections?.size ?? 0;
      if (nextTile?.code === "I") {
        result.intersection = true;
      }
      if (nextConnections <= 1) {
        result.deadEnd = true;
      }
      if (result.intersection || result.deadEnd) {
        result.stepsUntilStop = 1;
      } else if (state.dir) {
        const vec = TRAFFIC_DIRECTIONS[state.dir];
        if (vec) {
          let cursorX = nextTileX;
          let cursorY = nextTileY;
          for (let step = 2; step <= 3; step += 1) {
            cursorX += vec.dx;
            cursorY += vec.dy;
            const tile = this.level.getTile(cursorX, cursorY);
            const entry = this._getRoadEntry(cursorX, cursorY);
            const connections = entry?.connections?.size ?? 0;
            const isIntersection = tile?.code === "I";
            const isDeadEnd = connections <= 1;
            if (isIntersection || isDeadEnd) {
              result.stepsUntilStop = step;
              break;
            }
          }
        }
      }
      return result;
    };

    const turnSpeed = 5 * MPH_TO_METERS_PER_SECOND;
    const cruiseSpeed = 22;
    let upcoming = analyzeUpcoming();
    const currentSpeed = veh.physics.getSpeedMetersPerSecond();

    const selectTarget = () => state.targetWorld || { x: position.x, y: position.y };
    let target = selectTarget();
    let dx = target.x - position.x;
    let dy = target.y - position.y;
    let distance = Math.hypot(dx, dy);
    const recalcTarget = () => {
      target = selectTarget();
      dx = target.x - position.x;
      dy = target.y - position.y;
      distance = Math.hypot(dx, dy);
    };

    const arrivalThreshold = Math.max(6, TILE_SIZE * 0.15);
    if (distance < arrivalThreshold) {
      if (!this._finalizeTurnArrival(entry, state)) {
        return false;
      }
      upcoming = analyzeUpcoming();
      recalcTarget();
    }

    const sharingTile = this._hasOtherVehicleOnTile(veh, state.currentTileX, state.currentTileY);

    const desiredHeading = Math.atan2(target.y - position.y, target.x - position.x);
    const angleDiff = normalizeAngle(desiredHeading - veh.physics.heading);

    const input = {
      forward: false,
      reverse: false,
      left: angleDiff < -0.05,
      right: angleDiff > 0.05,
      brake: false
    };
    const steeringThreshold = (30 * Math.PI) / 180;
    input.throttleScale = Math.abs(angleDiff) > steeringThreshold ? 0.2 : 1;

    let targetSpeed;
    if (state.turning) {
      targetSpeed = turnSpeed;
      if (distance < TILE_SIZE * 0.6) {
        targetSpeed = Math.min(targetSpeed, turnSpeed);
      }
    } else {
      targetSpeed = cruiseSpeed - Math.min(Math.abs(angleDiff) * 8, 8);
      if (distance < TILE_SIZE * 0.6) {
        targetSpeed = Math.min(targetSpeed, 10);
      }
      targetSpeed = Math.max(6, targetSpeed);
    }
    let shouldCapToTurnSpeed = sharingTile || upcoming.intersection || upcoming.deadEnd;
    if (!shouldCapToTurnSpeed && upcoming.stepsUntilStop <= 2) {
      shouldCapToTurnSpeed = true;
    }
    if (shouldCapToTurnSpeed) {
      targetSpeed = Math.min(targetSpeed, turnSpeed);
    }

    const isIntersection = this.level.getTile(state.currentTileX, state.currentTileY)?.code === "I";
    if (currentSpeed < targetSpeed - 1) {
      input.forward = true;
    } else if (currentSpeed > targetSpeed + 3) {
      input.brake = true;
    } else if (!isIntersection) {
      input.forward = true;
    }

    const longitudinalBeforeUpdate = this._readLongitudinalSpeed(veh);

    veh.update(input, dt, bounds);
    state.lastLongitudinalSpeed = longitudinalBeforeUpdate;
    this._applyReverseBreaker(entry, dt);
    this._updateLineTargetTimer(entry, dt);
    return true;
  }

  spawnForRoadSegment(request) {
    if (!request) {
      return;
    }
    const { fromX, fromY, toX, toY } = request;
    if (
      !Number.isFinite(fromX) ||
      !Number.isFinite(fromY) ||
      !Number.isFinite(toX) ||
      !Number.isFinite(toY)
    ) {
      return;
    }
    const axis = fromY === toY ? "H" : "V";
    const coord = axis === "H" ? fromY : fromX;
    this._enqueueRoadLine(axis, coord);
  }

  _isPlayerTile(tileX, tileY) {
    if (!this.player || typeof this.player.getPosition !== "function") {
      return false;
    }
    const pos = this.player.getPosition();
    if (!pos) {
      return false;
    }
    const px = Math.floor(pos.x / TILE_SIZE);
    const py = Math.floor(pos.y / TILE_SIZE);
    return px === tileX && py === tileY;
  }

  _getPlayerTile() {
    const vehicleBody = this.playerVehicle?.body;
    if (vehicleBody && Number.isFinite(vehicleBody.x) && Number.isFinite(vehicleBody.y)) {
      return {
        x: Math.floor(vehicleBody.x / TILE_SIZE),
        y: Math.floor(vehicleBody.y / TILE_SIZE)
      };
    }
    if (this.player && typeof this.player.getPosition === "function") {
      const pos = this.player.getPosition();
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        return {
          x: Math.floor(pos.x / TILE_SIZE),
          y: Math.floor(pos.y / TILE_SIZE)
        };
      }
    }
    return null;
  }

  _isTileWithinPlayerChunks(tileX, tileY, playerTile) {
    if (!playerTile) {
      return true;
    }
    const chunkX = Math.floor(tileX / ZONE_SIZE);
    const chunkY = Math.floor(tileY / ZONE_SIZE);
    const playerChunkX = Math.floor(playerTile.x / ZONE_SIZE);
    const playerChunkY = Math.floor(playerTile.y / ZONE_SIZE);
    const dx = Math.abs(chunkX - playerChunkX);
    const dy = Math.abs(chunkY - playerChunkY);
    return dx + dy <= 1;
  }

  _isPlayerOccupyingTile(tileX, tileY) {
    if (this._isPlayerTile(tileX, tileY)) {
      return true;
    }
    const body = this.playerVehicle?.body;
    if (body) {
      const vx = Math.floor(body.x / TILE_SIZE);
      const vy = Math.floor(body.y / TILE_SIZE);
      if (vx === tileX && vy === tileY) {
        return true;
      }
    }
    return false;
  }

  _adjacentRoadTiles(tileX, tileY) {
    const results = [];
    const seen = new Set();
    for (const dir of Object.values(TRAFFIC_DIRECTIONS)) {
      const nx = tileX + dir.dx;
      const ny = tileY + dir.dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (this._isRoadTile(nx, ny)) {
        results.push({ x: nx, y: ny });
      }
    }
    return results;
  }

  _resolveSpawnTile(tileX, tileY) {
    if (this._isPlayerOccupyingTile(tileX, tileY)) {
      const options = this._adjacentRoadTiles(tileX, tileY).filter(
        (tile) => !this._isPlayerOccupyingTile(tile.x, tile.y) && !this._hasVehicleOnTile(tile.x, tile.y)
      );
      if (options.length > 0) {
        return options[Math.floor(Math.random() * options.length)];
      }
      const fallback = this._findNearestRoadTile(tileX, tileY, 3);
      if (
        fallback &&
        (fallback.x !== tileX || fallback.y !== tileY) &&
        !this._isPlayerOccupyingTile(fallback.x, fallback.y) &&
        !this._hasVehicleOnTile(fallback.x, fallback.y)
      ) {
        return fallback;
      }
      return null;
    }
    if (this._hasVehicleOnTile(tileX, tileY)) {
      return null;
    }
    return { x: tileX, y: tileY };
  }

  _countVehiclesOnLine(lineKey) {
    if (!lineKey) {
      return 0;
    }
    let count = 0;
    for (const entry of this.vehicles) {
      if (entry?.state?.lineKey === lineKey) {
        count += 1;
      }
    }
    return count;
  }

  _trimLineToLimit(lineKey, tileX = null, tileY = null) {
    if (!lineKey) {
      return;
    }
    const limit =
      tileX != null && tileY != null
        ? this._lineLimitForTile(tileX, tileY)
        : this._computeLineLimit(lineKey);
    let excess = this._countVehiclesOnLine(lineKey) - limit;
    if (excess <= 0) {
      return;
    }
    for (let i = this.vehicles.length - 1; i >= 0 && excess > 0; i -= 1) {
      const entry = this.vehicles[i];
      if (entry?.state?.lineKey === lineKey) {
        try {
          if (entry.veh?.body && typeof this.system.remove === "function") {
            this.system.remove(entry.veh.body);
          }
        } catch (_error) {}
        this.vehicles.splice(i, 1);
        excess -= 1;
      }
    }
  }

  draw(ctx, camera, assets) {
    const ordered = this.vehicles.slice().sort((a, b) => {
      const ay = a?.veh?.body?.y ?? 0;
      const by = b?.veh?.body?.y ?? 0;
      return ay - by;
    });
    for (const entry of ordered) {
      entry.veh.draw(ctx, camera, assets);
    }
  }

  _hasVehicleOnTile(tileX, tileY) {
    const checkBody = (body) => {
      if (!body) {
        return false;
      }
      const vx = Math.floor(body.x / TILE_SIZE);
      const vy = Math.floor(body.y / TILE_SIZE);
      return vx === tileX && vy === tileY;
    };
    if (checkBody(this.playerVehicle?.body)) {
      return true;
    }
    for (const entry of this.vehicles) {
      if (checkBody(entry?.veh?.body)) {
        return true;
      }
    }
    return false;
  }
}

class Player {
  constructor(system, startPose) {
    this.system = system;
    this.walkSpeed = 160;
    this.bodyWidth = 12;
    this.bodyHeight = 15;
    this.body = system.createBox(
      { x: startPose.x - TILE_SIZE * 0.75, y: startPose.y },
      this.bodyWidth,
      this.bodyHeight,
      { isStatic: false, isCentered: true }
    );
    this.defaultGroup = this.body.group;
    this.currentSpeed = 0;
    this.facingAngle = -Math.PI / 2;
    this.active = true;
    this.attachedVehicle = null;
  }

  attachToVehicle(vehicle) {
    this.active = false;
    this.attachedVehicle = vehicle;
    this.body.isTrigger = true;
    this.body.group = 0;
    this.currentSpeed = 0;
    this.facingAngle = vehicle.body.angle;
    this.syncWithVehicle();
  }

  detachFromVehicle(vehicle, offset) {
    this.active = true;
    const vehicleAngle = vehicle.body.angle;
    this.attachedVehicle = null;
    this.body.isTrigger = false;
    this.body.group = this.defaultGroup;
    this.body.setPosition(vehicle.body.x + offset.x, vehicle.body.y + offset.y);
    this.body.updateBody(true);
    this.currentSpeed = 0;
    this.facingAngle = vehicleAngle;
  }

  syncWithVehicle() {
    if (!this.attachedVehicle) {
      return;
    }
    const targetX = this.attachedVehicle.body.x;
    const targetY = this.attachedVehicle.body.y;
    if (this.body.x !== targetX || this.body.y !== targetY) {
      this.body.setPosition(targetX, targetY);
      this.body.updateBody(true);
    }
  }

  getPosition() {
    return { x: this.body.x, y: this.body.y };
  }

  getSpeed() {
    return this.currentSpeed;
  }

  getHeadingDegrees() {
    return ((this.facingAngle * RAD2DEG) % 360 + 360) % 360;
  }

  reset(startPose) {
    this.active = true;
    this.attachedVehicle = null;
    this.body.isTrigger = false;
    this.body.group = this.defaultGroup;
    this.body.setPosition(startPose.x - TILE_SIZE * 0.75, startPose.y);
    this.body.setAngle(0);
    this.body.updateBody(true);
    this.currentSpeed = 0;
    this.facingAngle = -Math.PI / 2;
  }

  update(inputState, dt, bounds) {
    if (!this.active) {
      this.syncWithVehicle();
      return;
    }

    const dirX = (inputState?.right ? 1 : 0) - (inputState?.left ? 1 : 0);
    const dirY = (inputState?.reverse ? 1 : 0) - (inputState?.forward ? 1 : 0);

    if (dirX === 0 && dirY === 0) {
      this.currentSpeed = 0;
      return;
    }

    const length = Math.hypot(dirX, dirY) || 1;
    const step = this.walkSpeed * dt;
    const velocityX = (dirX / length) * step;
    const velocityY = (dirY / length) * step;
    const startX = this.body.x;
    const startY = this.body.y;
    const nextX = startX + velocityX;
    const nextY = startY + velocityY;

    this.body.setPosition(nextX, nextY);

    this.system.separateBody(this.body, () => true);
    const halfWidth = this.bodyWidth / 2;
    const halfHeight = this.bodyHeight / 2;
    const clampedX = clamp(this.body.x, bounds.minX + halfWidth, bounds.maxX - halfWidth);
    const clampedY = clamp(this.body.y, bounds.minY + halfHeight, bounds.maxY - halfHeight);
    if (clampedX !== this.body.x || clampedY !== this.body.y) {
      this.body.setPosition(clampedX, clampedY);
    }

    const traveledX = this.body.x - startX;
    const traveledY = this.body.y - startY;
    const distance = Math.hypot(traveledX, traveledY);
    this.body.updateBody(distance > 0.001);
    this.currentSpeed = dt > 0 ? distance / dt : 0;
    if (distance > 0.001) {
      this.facingAngle = Math.atan2(traveledY, traveledX);
    } else {
      this.facingAngle = Math.atan2(dirY, dirX);
    }
  }

  draw(ctx, camera, assets) {
    if (!this.active) {
      return;
    }

    const sprite = assets.player;
    if (!sprite) {
      return;
    }

    const drawX = this.body.x - camera.x;
    const drawY = this.body.y - camera.y;
    const renderHeight = 27;
    const aspectRatio = sprite.width ? sprite.height / sprite.width : 1;
    const renderWidth = renderHeight / aspectRatio;

    ctx.save();
    ctx.translate(drawX, drawY);
    ctx.drawImage(
      sprite,
      -renderWidth / 2,
      -renderHeight / 2,
      renderWidth,
      renderHeight
    );
    ctx.restore();
  }

  serializeState() {
    return {
      active: this.active,
      position: { x: this.body.x, y: this.body.y },
      facingAngle: this.facingAngle
    };
  }

  restoreState(state = {}) {
    if (!state || typeof state !== "object") {
      return;
    }
    const active = state.active !== false;
    this.active = active;
    this.attachedVehicle = null;
    if (active) {
      this.body.isTrigger = false;
      this.body.group = this.defaultGroup;
    } else {
      this.body.isTrigger = true;
      this.body.group = 0;
    }
    const position = state.position;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      this.body.setPosition(position.x, position.y);
    }
    if (Number.isFinite(state.facingAngle)) {
      this.facingAngle = state.facingAngle;
    }
    this.body.updateBody(true);
    this.currentSpeed = 0;
  }
}

class HUD {
  constructor() {
    this.root = document.querySelector(".panel");
    this.carEl = document.getElementById("stat-car");
    this.yearEl = document.getElementById("stat-year");
    this.originEl = document.getElementById("stat-origin");
    this.speedEl = document.getElementById("stat-speed");
    this.headingEl = document.getElementById("stat-heading");
    this.positionEl = document.getElementById("stat-position");
    this.zoneEl = document.getElementById("stat-zone");
    this.collisionsEl = document.getElementById("stat-collisions");
    this.transmissionEl = document.getElementById("stat-transmission");
    this.gearEl = document.getElementById("stat-gear");
    this.rpmEl = document.getElementById("stat-rpm");
    this.throttleEl = document.getElementById("stat-throttle");
    this.brakeEl = document.getElementById("stat-brake");
    this.longitudinalEl = document.getElementById("stat-longitudinal");
    this.lateralEl = document.getElementById("stat-lateral");
    this.powerEl = document.getElementById("stat-power");
    this.massEl = document.getElementById("stat-mass");
    this.torqueEl = document.getElementById("stat-torque");
    this.driveTypeEl = document.getElementById("stat-drive");
    this.revLimitEl = document.getElementById("stat-revlimit");
    this.brakeHpEl = document.getElementById("stat-brakehp");
    this.finalDriveEl = document.getElementById("stat-finaldrive");
    this.gearCountEl = document.getElementById("stat-gearcount");
    this.gearRatiosEl = document.getElementById("stat-gearratios");
    this.dragEl = document.getElementById("stat-drag");
    this.downforceEl = document.getElementById("stat-downforce");
    this.frontalEl = document.getElementById("stat-frontal");
    this.wheelbaseEl = document.getElementById("stat-wheelbase");
    this.trackEl = document.getElementById("stat-track");
    this.cgEl = document.getElementById("stat-cg");
    this.weightFrontEl = document.getElementById("stat-weightfront");
    this.wheelRadiusEl = document.getElementById("stat-wheelradius");
    this.frontGripEl = document.getElementById("stat-frontgrip");
    this.rearGripEl = document.getElementById("stat-reargrip");
    this.brakeTorqueFrontEl = document.getElementById("stat-brake-front");
    this.brakeTorqueRearEl = document.getElementById("stat-brake-rear");
    this.brakeBiasEl = document.getElementById("stat-brakebias");
    this.drivetrainEffEl = document.getElementById("stat-drivetrain");
    this.rollingEl = document.getElementById("stat-rolling");
    this.sourcesEl = document.getElementById("stat-sources");
    this.dashEl = document.getElementById("dash-cluster");
    this.dashSpeedEl = document.getElementById("dash-speed-value");
    this.dashRpmEl = document.getElementById("dash-rpm-value");
    this.dashGearEl = document.getElementById("dash-gear-value");
  }

  setVisible(visible) {
    if (this.root) {
      this.root.classList.toggle("is-hidden", !visible);
    }
  }

  setDashboardVisible(visible) {
    if (this.dashEl) {
      this.dashEl.classList.toggle("is-hidden", !visible);
    }
  }

  applyStaticSpec(spec = {}) {
    if (!spec) {
      return;
    }
    const {
      carLabel,
      year,
      country,
      powerHp,
      massKg,
      torqueNm,
      driveType,
      revLimiterRpm,
      brakeHorsepower,
      finalDrive,
      gearCount,
      gearRatios,
      dragCoefficient,
      downforceCoefficient,
      frontalAreaM2,
      wheelbaseM,
      trackWidthM,
      cgHeightM,
      frontWeightDistribution,
      wheelRadiusM,
      tireGripFrontLong,
      tireGripRearLong,
      tireGripFrontLat,
      tireGripRearLat,
      brakeTorqueFrontNm,
      brakeTorqueRearNm,
      brakeBiasFront,
      drivetrainEfficiency,
      rollingResistanceCoeff,
      sources
    } = spec;

    if (this.carEl) {
      this.carEl.textContent = carLabel ? carLabel : "-";
    }
    if (this.yearEl) {
      this.yearEl.textContent = year != null ? String(year) : "-";
    }
    if (this.originEl) {
      this.originEl.textContent = country ?? "-";
    }
    if (this.powerEl) {
      this.powerEl.textContent = formatNumber(powerHp, 0);
    }
    if (this.massEl) {
      this.massEl.textContent = formatNumber(massKg, 0);
    }
    if (this.torqueEl) {
      this.torqueEl.textContent = Number.isFinite(torqueNm) ? `${torqueNm.toFixed(0)} Nm` : "-";
    }
    if (this.driveTypeEl) {
      this.driveTypeEl.textContent = driveType ? driveType.toUpperCase() : "-";
    }
    if (this.revLimitEl) {
      this.revLimitEl.textContent = Number.isFinite(revLimiterRpm) ? `${revLimiterRpm.toFixed(0)} rpm` : "-";
    }
    if (this.brakeHpEl) {
      this.brakeHpEl.textContent = Number.isFinite(brakeHorsepower) ? `${brakeHorsepower.toFixed(0)} hp` : "-";
    }
    if (this.finalDriveEl) {
      this.finalDriveEl.textContent = Number.isFinite(finalDrive) ? finalDrive.toFixed(2) : "-";
    }
    if (this.gearCountEl) {
      this.gearCountEl.textContent = Number.isFinite(gearCount) ? gearCount.toString() : "-";
    }
    if (this.gearRatiosEl) {
      this.gearRatiosEl.textContent = formatGearRatios(gearRatios);
    }
    if (this.dragEl) {
      this.dragEl.textContent = formatNumber(dragCoefficient, 2);
    }
    if (this.downforceEl) {
      this.downforceEl.textContent = formatNumber(downforceCoefficient, 2);
    }
    if (this.frontalEl) {
      this.frontalEl.textContent = formatWithUnit(frontalAreaM2, "m²", 2);
    }
    if (this.wheelbaseEl) {
      this.wheelbaseEl.textContent = formatWithUnit(wheelbaseM, "m", 3);
    }
    if (this.trackEl) {
      this.trackEl.textContent = formatWithUnit(trackWidthM, "m", 3);
    }
    if (this.cgEl) {
      this.cgEl.textContent = formatWithUnit(cgHeightM, "m", 3);
    }
    if (this.weightFrontEl) {
      this.weightFrontEl.textContent = formatPercent(frontWeightDistribution);
    }
    if (this.wheelRadiusEl) {
      this.wheelRadiusEl.textContent = formatWithUnit(wheelRadiusM, "m", 3);
    }
    if (this.frontGripEl) {
      this.frontGripEl.textContent = formatGripPair(tireGripFrontLong, tireGripFrontLat);
    }
    if (this.rearGripEl) {
      this.rearGripEl.textContent = formatGripPair(tireGripRearLong, tireGripRearLat);
    }
    if (this.brakeTorqueFrontEl) {
      this.brakeTorqueFrontEl.textContent = Number.isFinite(brakeTorqueFrontNm)
        ? brakeTorqueFrontNm.toFixed(0)
        : "-";
    }
    if (this.brakeTorqueRearEl) {
      this.brakeTorqueRearEl.textContent = Number.isFinite(brakeTorqueRearNm)
        ? brakeTorqueRearNm.toFixed(0)
        : "-";
    }
    if (this.brakeBiasEl) {
      this.brakeBiasEl.textContent = formatPercent(brakeBiasFront, 1);
    }
    if (this.drivetrainEffEl) {
      this.drivetrainEffEl.textContent = formatPercent(drivetrainEfficiency);
    }
    if (this.rollingEl) {
      this.rollingEl.textContent = formatNumber(rollingResistanceCoeff, 3);
    }
    if (this.sourcesEl) {
      this.sourcesEl.textContent = formatSourcesList(sources);
    }
  }

  update({
    carLabel,
    speed,
    heading,
    position,
    zone,
    collisions,
    transmission,
    gear,
    rpm,
    throttle,
    brake,
    longG,
    latG,
    powerHp,
    massKg,
    torqueNm,
    driveType,
    revLimiterRpm,
    brakeHorsepower,
    finalDrive,
    gearRatios,
    gearCount,
    dragCoefficient,
    downforceCoefficient,
    frontalAreaM2,
    wheelbaseM,
    trackWidthM,
    cgHeightM,
    frontWeightDistribution,
    wheelRadiusM,
    tireGripFrontLong,
    tireGripRearLong,
    tireGripFrontLat,
    tireGripRearLat,
    tireGripLongArray,
    tireGripLatArray,
    drivetrainEfficiency,
    rollingResistanceCoeff,
    sources,
    year,
    country,
    brakeTorqueFrontNm,
    brakeTorqueRearNm,
    brakeBiasFront
  }) {
    this.applyStaticSpec({
      carLabel,
      powerHp,
      massKg,
      torqueNm,
      driveType,
      revLimiterRpm,
      brakeHorsepower,
      finalDrive,
      gearRatios,
      gearCount,
      dragCoefficient,
      downforceCoefficient,
      frontalAreaM2,
      wheelbaseM,
      trackWidthM,
      cgHeightM,
      frontWeightDistribution,
      wheelRadiusM,
      tireGripFrontLong,
      tireGripRearLong,
      tireGripFrontLat,
      tireGripRearLat,
      tireGripLongArray,
      tireGripLatArray,
      brakeTorqueFrontNm,
      brakeTorqueRearNm,
      brakeBiasFront,
      drivetrainEfficiency,
      rollingResistanceCoeff,
      sources,
      year,
      country
    });
    const speedKph = speed / PIXELS_PER_METER * 3.6;
    if (this.speedEl) {
      this.speedEl.textContent = speedKph.toFixed(0);
    }
    if (this.headingEl) {
      this.headingEl.textContent = heading.toFixed(0);
    }
    if (this.positionEl) {
      const { x, y } = position;
      this.positionEl.textContent = `${x.toFixed(0)}, ${y.toFixed(0)}`;
    }
    if (this.zoneEl) {
      this.zoneEl.textContent = zone;
    }
    if (this.collisionsEl) {
      this.collisionsEl.textContent = String(collisions);
    }
    if (this.transmissionEl) {
      this.transmissionEl.textContent = transmission ?? "Automatic";
    }
    if (this.gearEl) {
      this.gearEl.textContent = gear ?? "-";
    }
    if (this.rpmEl) {
      this.rpmEl.textContent = rpm != null ? rpm.toFixed(0) : "0";
    }
    if (this.throttleEl) {
      const pct = throttle != null ? Math.round(clamp(Math.abs(throttle), 0, 1) * 100) : 0;
      this.throttleEl.textContent = String(pct);
    }
    if (this.brakeEl) {
      const pct = brake != null ? Math.round(clamp(brake, 0, 1) * 100) : 0;
      this.brakeEl.textContent = String(pct);
    }
    if (this.longitudinalEl) {
      const value = longG != null ? longG : 0;
      this.longitudinalEl.textContent = value.toFixed(2);
    }
    if (this.lateralEl) {
      const value = latG != null ? latG : 0;
      this.lateralEl.textContent = value.toFixed(2);
    }
    if (this.powerEl) {
      this.powerEl.textContent = powerHp != null ? powerHp.toFixed(0) : "-";
    }
    if (this.massEl) {
      this.massEl.textContent = massKg != null ? massKg.toFixed(0) : "-";
    }
    if (this.dashSpeedEl) {
      const speedMph = speedKph * 0.621371;
      this.dashSpeedEl.textContent = Number.isFinite(speedMph) ? speedMph.toFixed(0) : "0";
    }
    if (this.dashRpmEl) {
      this.dashRpmEl.textContent = rpm != null ? rpm.toFixed(0) : "0";
    }
    if (this.dashGearEl) {
      this.dashGearEl.textContent = gear != null ? String(gear) : "-";
    }
  }
}

class Game {
  constructor(canvas, context, assets, options = {}) {
    this.canvas = canvas;
    this.ctx = context;
    this.assets = assets;
    // Prefer requesting fullscreen on the wrapper that contains the canvas and overlays
    // so HUD/minimap remain visible in fullscreen. Fall back to the canvas if wrapper
    // is not present in the DOM (e.g., embedding environments).
    this.fullscreenRoot = (this.canvas && this.canvas.closest)
      ? this.canvas.closest(".viewport-wrapper") || this.canvas.parentElement || this.canvas
      : this.canvas;
    (this.fullscreenRoot || this.canvas).addEventListener("dblclick", () => this.toggleFullscreen());
    this.system = new System();
    this.level = new Level(TILESET, this.system);
    this.carSpec = options.carSpec ?? null;
    const carId = this.carSpec?.id ?? options.carId ?? null;
    if (options.carConfig) {
      this.carConfig = cloneCarConfig(options.carConfig);
    } else if (this.carSpec?.specs) {
      this.carConfig = createCarConfigFromSpec(this.carSpec.specs, { carId });
    } else {
      this.carConfig = createCarConfigFromSpec({}, { carId, applyOverrides: false });
    }
    this.vehicle = new Vehicle(
      this.system,
      this.level.startPose,
      this.carConfig,
      this.carSpec,
      { precomputedConfig: true, level: this.level }
    );
    this.player = new Player(this.system, this.level.startPose);
  this.traffic = new TrafficManager(this.system, this.level, this.assets, this.player, this.vehicle);
    // register traffic manager so Level.markRoadStep can notify it and drain any queued segments
    try {
      this.level.trafficManager = this.traffic;
      if (Array.isArray(globalThis.__pendingRoadSpawns) && globalThis.__pendingRoadSpawns.length > 0) {
        const pending = globalThis.__pendingRoadSpawns.splice(0);
        for (const req of pending) {
          try { this.traffic.spawnForRoadSegment(req); } catch (_e) {}
        }
      }
    } catch (_e) {}
    this.camera = new Camera(canvas, this.level);
    this.input = new InputManager();
    this.hud = options.hud || new HUD();
    this.debug = false;
    this.lastTimestamp = null;
    this.mode = "driving";
    this.specDisplay = options.specDisplay ?? buildSpecDisplay(this.carConfig, this.carSpec);
    this.hud.applyStaticSpec(this.specDisplay);
    this.carLabel = this.specDisplay?.carLabel ?? formatCarLabel(this.carSpec);
    if (this.mode === "driving") {
      this.player.attachToVehicle(this.vehicle);
    }
    this.loop = this.loop.bind(this);
    this.trafficActivationPending = false;

    this.minimap = new MiniMap(document.getElementById("minimap"));
    this.pauseOverlay = document.getElementById("pause-overlay");
    this.resumeButton = document.getElementById("resume-button");
    this.exitButton = document.getElementById("exit-button");
    this.saveButton = document.getElementById("save-button");
    this.saveStatusEl = document.getElementById("save-status");
    this.saveStatusTimeout = null;
    this.pauseCarSelect = document.getElementById("pause-car-select");
    this.pauseCarLoadButton = document.getElementById("pause-car-load");
    this.pauseCarStatusEl = document.getElementById("pause-car-status");
    this.canPersistSave = Boolean(getSaveStorage());
    this.raceHintEl = document.getElementById("race-hint");
    this.raceMenuEl = document.getElementById("race-menu");
    this.raceMenuTitleEl = document.getElementById("race-menu-title");
    this.raceMenuDetailEl = document.getElementById("race-menu-detail");
    this.raceMenuStartButton = document.getElementById("race-menu-start");
    this.raceMenuCancelButton = document.getElementById("race-menu-cancel");
    this.raceMenuVisible = false;
    this.availableTimeTrial = null;
    this.availableAiRace = null;
    this.raceMenuTrial = null;
    this.raceMenuRace = null;
    this.raceMenuMode = "timeTrial";
    this.activeTimeTrial = null;
    this.activeAiRace = null;
    this.aiRaceOpponents = [];
    this.aiRaceResults = [];
    this.raceHintTimeout = null;
    this.raceHintMode = null;
    this.raceCompleteEl = document.getElementById("race-complete");
    this.raceCompleteTimeEl = document.getElementById("race-complete-time");
    this.raceCompleteSummaryEl = document.getElementById("race-complete-summary");
    this.raceCompleteLeaderboardEl = document.getElementById("race-complete-leaderboard");
    this.raceCompleteCloseButton = document.getElementById("race-complete-close");
    this.raceCompleteVisible = false;
    this.raceCompleteTrial = null;
    this.raceCompleteRace = null;
    this.raceCompleteMode = "timeTrial";
    this.handleResume = () => this.togglePause(false);
    this.handleExit = () => this.exitToMenu();
    this.handleSave = () => this.saveGame();
    this.handleRaceStart = () => this.confirmRaceStart();
    this.handleRaceCancel = () => this.closeRaceMenu();
    this.handleRaceCompleteClose = () => this.hideRaceComplete();
    this.handlePauseCarLoad = () => this.loadSelectedPauseCar();
    if (this.resumeButton) {
      this.resumeButton.addEventListener("click", this.handleResume);
    }
    if (this.exitButton) {
      this.exitButton.addEventListener("click", this.handleExit);
    }
    if (this.saveButton) {
      if (this.canPersistSave) {
        this.saveButton.disabled = false;
        this.saveButton.addEventListener("click", this.handleSave);
      } else {
        this.saveButton.disabled = true;
        this.saveButton.title = "Saving is unavailable in this environment.";
      }
    }
    if (this.pauseCarSelect) {
      this._populatePauseCarSelect();
      this._updatePauseCarSelection();
    }
    if (this.pauseCarLoadButton) {
      this.pauseCarLoadButton.addEventListener("click", this.handlePauseCarLoad);
    }
    if (this.raceMenuStartButton) {
      this.raceMenuStartButton.addEventListener("click", this.handleRaceStart);
    }
    if (this.raceMenuCancelButton) {
      this.raceMenuCancelButton.addEventListener("click", this.handleRaceCancel);
    }
    if (this.raceCompleteCloseButton) {
      this.raceCompleteCloseButton.addEventListener("click", this.handleRaceCompleteClose);
    }

    this.onExit = typeof options.onExit === "function" ? options.onExit : null;
    this.onSaved = typeof options.onSaved === "function" ? options.onSaved : null;
    this.paused = false;
    this.hud.setVisible(false);
    this.hud.setDashboardVisible(true);
    if (this.minimap) {
      this.minimap.setVisible(true);
    }
    // start traffic after initialization
    try {
      this.traffic.start();
    } catch (_e) {}
    this.showPauseOverlay(false);
    this.updateSaveStatus(null);
  }

  start() {
    if (this.tickHandle) {
      return;
    }
    this.paused = false;
    this.lastTimestamp = null;
    this.input.clearMovementState();
    this.hud.setVisible(false);
    this.hud.setDashboardVisible(true);
    if (this.minimap) {
      this.minimap.setVisible(true);
    }
    this.showPauseOverlay(false);
    const tick = (timestamp) => {
      this.tickHandle = typeof window !== "undefined" && window.requestAnimationFrame
        ? window.requestAnimationFrame(tick)
        : setTimeout(() => tick(performance.now()), 1000 / 60);
      this.loop(timestamp);
    };
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      this.tickHandle = window.requestAnimationFrame(tick);
    } else {
      this.tickHandle = setTimeout(() => tick(performance.now()), 1000 / 60);
    }
    if (this.traffic) {
      this.trafficActivationPending = true;
    }
  }

  stop() {
    if (this.tickHandle) {
      if (typeof window !== "undefined" && window.cancelAnimationFrame && typeof this.tickHandle === "number") {
        window.cancelAnimationFrame(this.tickHandle);
      } else {
        clearTimeout(this.tickHandle);
      }
      this.tickHandle = null;
    }
    if (this.resumeButton) {
      this.resumeButton.removeEventListener("click", this.handleResume);
    }
    if (this.exitButton) {
      this.exitButton.removeEventListener("click", this.handleExit);
    }
    if (this.saveButton) {
      this.saveButton.removeEventListener("click", this.handleSave);
    }
    if (this.pauseCarLoadButton) {
      this.pauseCarLoadButton.removeEventListener("click", this.handlePauseCarLoad);
    }
    if (this.raceMenuStartButton) {
      this.raceMenuStartButton.removeEventListener("click", this.handleRaceStart);
    }
    if (this.raceMenuCancelButton) {
      this.raceMenuCancelButton.removeEventListener("click", this.handleRaceCancel);
    }
    if (this.raceCompleteCloseButton) {
      this.raceCompleteCloseButton.removeEventListener("click", this.handleRaceCompleteClose);
    }
    if (this.saveStatusTimeout) {
      clearTimeout(this.saveStatusTimeout);
      this.saveStatusTimeout = null;
    }
    if (this.minimap) {
      this.minimap.setVisible(false);
    }
    this.hideRaceHint();
    this.closeRaceMenu();
    this.hideRaceComplete();
    this.showPauseOverlay(false);
    this.hud.setDashboardVisible(false);
    this.paused = false;
    this.input.clearMovementState();
    this._cleanupAiRaceOpponents();
    this.activeAiRace = null;
  }

  togglePause(force) {
    const nextState = typeof force === "boolean" ? force : !this.paused;
    if (nextState === this.paused) {
      return;
    }
    if (nextState && this.raceMenuVisible) {
      this.closeRaceMenu();
    }
    if (nextState && this.raceCompleteVisible) {
      this.hideRaceComplete();
    }
    this.paused = nextState;
    if (this.paused) {
      this.input.clearMovementState();
      this.hud.setVisible(true);
      this.hud.setDashboardVisible(false);
      if (this.minimap) {
        this.minimap.setVisible(false);
      }
      this.showPauseOverlay(true);
    } else {
      this.hud.setVisible(false);
      this.hud.setDashboardVisible(true);
      if (this.minimap) {
        this.minimap.setVisible(true);
      }
      this.showPauseOverlay(false);
      this.lastTimestamp = null;
      this.updateSaveStatus(null);
    }
  }

  showPauseOverlay(show) {
    if (!this.pauseOverlay) {
      return;
    }
    if (show) {
      this.pauseOverlay.classList.remove("is-hidden");
      this.pauseOverlay.setAttribute("aria-hidden", "false");
      this._updatePauseCarSelection();
      this._updatePauseCarStatus(null);
      if (this.resumeButton) {
        setTimeout(() => this.resumeButton.focus(), 0);
      }
    } else {
      this.pauseOverlay.classList.add("is-hidden");
      this.pauseOverlay.setAttribute("aria-hidden", "true");
      this.updateSaveStatus(null);
    }
  }

  exitToMenu() {
    this.paused = false;
    this.showPauseOverlay(false);
    if (this.minimap) {
      this.minimap.setVisible(false);
    }
    this.hud.setDashboardVisible(false);
    this.hud.setVisible(false);
    this.hideRaceHint();
    this.closeRaceMenu();
    this.hideRaceComplete();
    this.stop();
    if (this.onExit) {
      this.onExit();
    }
  }

  updateSaveStatus(message, isError = false) {
    if (!this.saveStatusEl) {
      return;
    }
    if (this.saveStatusTimeout) {
      clearTimeout(this.saveStatusTimeout);
      this.saveStatusTimeout = null;
    }
    if (!message) {
      this.saveStatusEl.textContent = "";
      this.saveStatusEl.classList.add("is-hidden");
      this.saveStatusEl.classList.remove("is-error");
      return;
    }
    this.saveStatusEl.textContent = message;
    this.saveStatusEl.classList.remove("is-hidden");
    if (isError) {
      this.saveStatusEl.classList.add("is-error");
    } else {
      this.saveStatusEl.classList.remove("is-error");
      this.saveStatusTimeout = setTimeout(() => {
        this.saveStatusTimeout = null;
        this.updateSaveStatus(null);
      }, 4000);
    }
  }

  _populatePauseCarSelect() {
    if (!this.pauseCarSelect) {
      return;
    }
    this.pauseCarSelect.innerHTML = "";
    if (!Array.isArray(CAR_CATALOG) || CAR_CATALOG.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No cars available";
      option.disabled = true;
      option.selected = true;
      this.pauseCarSelect.appendChild(option);
      return;
    }
    CAR_CATALOG.forEach((car, index) => {
      const option = document.createElement("option");
      option.value = car.id ?? `car-${index}`;
      option.dataset.index = String(index);
      option.textContent = formatCarLabel(car);
      this.pauseCarSelect.appendChild(option);
    });
  }

  _updatePauseCarSelection() {
    if (!this.pauseCarSelect) {
      return;
    }
    const selectedId = this.carSpec?.id ?? "";
    const options = Array.from(this.pauseCarSelect.options || []);
    const match = options.find((opt) => opt.value === selectedId);
    if (match) {
      this.pauseCarSelect.value = selectedId;
    } else if (options.length > 0) {
      this.pauseCarSelect.value = options[0].value;
    }
  }

  _updatePauseCarStatus(message, isError = false) {
    if (!this.pauseCarStatusEl) {
      return;
    }
    if (!message) {
      this.pauseCarStatusEl.textContent = "";
      this.pauseCarStatusEl.classList.add("is-hidden");
      this.pauseCarStatusEl.classList.remove("is-error");
      return;
    }
    this.pauseCarStatusEl.textContent = message;
    this.pauseCarStatusEl.classList.remove("is-hidden");
    if (isError) {
      this.pauseCarStatusEl.classList.add("is-error");
    } else {
      this.pauseCarStatusEl.classList.remove("is-error");
    }
  }

  loadSelectedPauseCar() {
    if (!this.pauseCarSelect) {
      return;
    }
    const carId = this.pauseCarSelect.value;
    let spec = typeof findCarById === "function" ? findCarById(carId) : null;
    if (!spec) {
      const selectedOption = this.pauseCarSelect.selectedIndex >= 0
        ? this.pauseCarSelect.options[this.pauseCarSelect.selectedIndex]
        : null;
      if (selectedOption?.dataset?.index) {
        const idx = Number.parseInt(selectedOption.dataset.index, 10);
        if (Number.isFinite(idx) && CAR_CATALOG[idx]) {
          spec = CAR_CATALOG[idx];
        }
      }
    }
    if (!spec) {
      this._updatePauseCarStatus("Unable to load that car.", true);
      return;
    }
    if (this.carSpec?.id === spec.id) {
      this._updatePauseCarStatus("Already driving this car.", false);
      return;
    }
    const success = this.swapPlayerCar(spec);
    if (success) {
      this._updatePauseCarStatus(`Loaded ${formatCarLabel(spec)}.`, false);
      this._updatePauseCarSelection();
    } else {
      this._updatePauseCarStatus("Unable to load that car.", true);
    }
  }

  swapPlayerCar(carSpec) {
    if (!carSpec) {
      return false;
    }
    const oldVehicle = this.vehicle;
    if (!oldVehicle) {
      return false;
    }
    const pose = {
      x: oldVehicle.body?.x ?? this.level.startPose.x,
      y: oldVehicle.body?.y ?? this.level.startPose.y,
      angle: oldVehicle.body?.angle ?? this.level.startPose.angle
    };
    const velocity = oldVehicle.physics
      ? { x: oldVehicle.physics.velocity.x, y: oldVehicle.physics.velocity.y }
      : { x: 0, y: 0 };
    const angularVelocity = oldVehicle.physics?.angularVelocity ?? 0;
    try {
      if (oldVehicle.body && typeof this.system.remove === "function") {
        this.system.remove(oldVehicle.body);
      }
    } catch (_error) {}
    const config = createCarConfigFromSpec(carSpec.specs ?? {}, { carId: carSpec.id });
    const replacement = new Vehicle(
      this.system,
      pose,
      config,
      carSpec,
      { precomputedConfig: true, level: this.level }
    );
    replacement.physics.setWorldPosition(pose.x, pose.y);
    replacement.body.setPosition(pose.x, pose.y);
    replacement.body.setAngle(pose.angle);
    replacement.physics.heading = pose.angle;
    replacement.physics.velocity.x = velocity.x ?? 0;
    replacement.physics.velocity.y = velocity.y ?? 0;
    replacement.physics.angularVelocity = angularVelocity;
    this.vehicle = replacement;
    this.carSpec = carSpec;
    this.carConfig = config;
    this.carLabel = formatCarLabel(carSpec);
    this.specDisplay = buildSpecDisplay(config, carSpec);
    this.hud.applyStaticSpec(this.specDisplay);
    this.player.attachToVehicle(this.vehicle);
    if (this.traffic) {
      this.traffic.playerVehicle = this.vehicle;
    }
    return true;
  }

  buildSavePayload() {
    const payload = {
      savedAt: Date.now(),
      carId: this.carSpec?.id ?? null,
      carLabel: this.carLabel ?? formatCarLabel(this.carSpec),
      carConfig: cloneCarConfig(this.carConfig),
      mode: this.mode,
      vehicle:
        typeof this.vehicle.serializeState === "function"
          ? this.vehicle.serializeState()
          : null,
      player:
        typeof this.player.serializeState === "function"
          ? this.player.serializeState()
          : null
    };
    if (this.level && typeof this.level.serializeTimeTrials === "function") {
      const timeTrials = this.level.serializeTimeTrials();
      if (timeTrials) {
        timeTrials.activeTrialId = this.activeTimeTrial?.id ?? null;
        timeTrials.availableTrialId = this.availableTimeTrial?.id ?? null;
        timeTrials.raceMenuTrialId = this.raceMenuTrial?.id ?? null;
        timeTrials.raceCompleteTrialId = this.raceCompleteTrial?.id ?? null;
        timeTrials.activeAiRaceId = this.activeAiRace?.event?.id ?? null;
        timeTrials.availableAiRaceId = this.availableAiRace?.id ?? null;
        timeTrials.raceMenuRaceId = this.raceMenuRace?.id ?? null;
        timeTrials.raceCompleteRaceId = this.raceCompleteRace?.id ?? null;
        payload.timeTrials = timeTrials;
      }
    }
    return payload;
  }

  saveGame() {
    if (!this.canPersistSave) {
      this.updateSaveStatus("Saving is unavailable in this environment.", true);
      return false;
    }
    const payload = this.buildSavePayload();
    const slot = addSaveSlot(payload);
    if (!slot) {
      this.updateSaveStatus(
        "Unable to save. Check browser storage permissions.",
        true
      );
      return false;
    }
    const timestamp = formatSaveTimestamp(slot.savedAt);
    const message = timestamp ? `Saved "${slot.name}" (${timestamp})` : `Saved "${slot.name}"`;
    this.updateSaveStatus(message, false);
    if (typeof this.onSaved === "function") {
      this.onSaved(slot);
    }
    return true;
  }

  applySaveState(save) {
    if (!save || typeof save !== "object") {
      return false;
    }
    if (save.timeTrials && typeof this.level.restoreTimeTrials === "function") {
      const restored = this.level.restoreTimeTrials(save.timeTrials);
      const trialMap = new Map(
        restored.filter((event) => event.eventType !== "aiRace").map((trial) => [trial.id, trial])
      );
      const raceMap = new Map(
        restored.filter((event) => event.eventType === "aiRace").map((race) => [race.id, race])
      );
      const resolveTrial = (id) => (id == null ? null : trialMap.get(id) ?? null);
      const resolveRace = (id) => (id == null ? null : raceMap.get(id) ?? null);
      this.activeTimeTrial = resolveTrial(save.timeTrials.activeTrialId);
      this.availableTimeTrial = resolveTrial(save.timeTrials.availableTrialId);
      this.raceMenuTrial = resolveTrial(save.timeTrials.raceMenuTrialId);
      this.raceCompleteTrial = resolveTrial(save.timeTrials.raceCompleteTrialId);
      if (this.activeTimeTrial) {
        this.activeTimeTrial.lastTickTime = this.nowMs();
      }
      this.activeAiRace = null;
      this.availableAiRace = resolveRace(save.timeTrials.availableAiRaceId);
      this.raceMenuRace = resolveRace(save.timeTrials.raceMenuRaceId);
      this.raceCompleteRace = resolveRace(save.timeTrials.raceCompleteRaceId);
    } else {
      this.activeTimeTrial = null;
      this.availableTimeTrial = null;
      this.raceMenuTrial = null;
      this.raceCompleteTrial = null;
      this.activeAiRace = null;
      this.availableAiRace = null;
      this.raceMenuRace = null;
      this.raceCompleteRace = null;
    }
    if (save.vehicle && typeof this.vehicle.restoreState === "function") {
      this.vehicle.restoreState(save.vehicle);
    }
    const desiredMode = save.mode === "onFoot" ? "onFoot" : "driving";
    this.mode = desiredMode;
    if (desiredMode === "driving") {
      this.player.attachToVehicle(this.vehicle);
    } else {
      const playerState = { ...(save.player ?? {}), active: true };
      this.player.restoreState(playerState);
    }
    if (this.minimap) {
      this.minimap.prevChunkKey = null;
      const activeEntity = this.mode === "driving" ? this.vehicle : this.player;
      const position =
        typeof activeEntity.getPosition === "function"
          ? activeEntity.getPosition()
          : this.vehicle.getPosition();
      this.minimap.update(this.level, position, this.vehicle.physics.heading);
    }
    this.camera.update(this.mode === "driving" ? this.vehicle : this.player, 0);
    return true;
  }

  loop(timestamp) {
    if (this.tickHandle == null || this.loopRunning) {
      return;
    }
    this.loopRunning = true;
    if (this.lastTimestamp == null) {
      this.lastTimestamp = timestamp;
      this.loopRunning = false;
      return;
    }
    let delta = (timestamp - this.lastTimestamp) / 1000;
    if (delta < 0.0005) {
      delta = 1 / 60;
    }
    delta = Math.min(Math.max(delta, 0), 0.1);
    const raceMenuBlocking = this.raceMenuVisible || this.raceCompleteVisible;

    if (this.trafficActivationPending && this.traffic && !this.traffic.spawningEnabled) {
      try {
        this.traffic.requestSpawnActivation();
      } catch (_error) {}
      this.trafficActivationPending = false;
    }

    if (this.input.consumePauseToggle()) {
      this.togglePause();
    }

    if (!this.paused && !raceMenuBlocking) {
      if (this.input.consumeReset()) {
        this.resetVehicle({ preserveCollisions: true });
      }

      if (this.input.consumeInteract()) {
        this.handleInteract();
      }

      if (this.input.consumeToggleTransmission()) {
        this.vehicle.toggleTransmissionMode();
      }
      if (this.input.consumeShiftUp()) {
        this.vehicle.shiftUp();
      }
      if (this.input.consumeShiftDown()) {
        this.vehicle.shiftDown();
      }

      const vehicleInput = this.mode === "driving" ? this.input.state : ZERO_INPUT;
      const playerInput = this.mode === "driving" ? ZERO_INPUT : this.input.state;

      this.vehicle.update(vehicleInput, delta, this.level.bounds);
      this.player.update(playerInput, delta, this.level.bounds);
      // update traffic NPCs
      if (this.traffic) {
        try {
          this.traffic.update(delta);
        } catch (_e) {}
      }
      this.camera.update(this.mode === "driving" ? this.vehicle : this.player, delta);
    } else {
      this.camera.update(this.mode === "driving" ? this.vehicle : this.player, 0);
    }

    const activeEntity = this.mode === "driving" ? this.vehicle : this.player;
    const activePosition = activeEntity.getPosition();
    const playerTileX = Math.floor(activePosition.x / TILE_SIZE);
    const playerTileY = Math.floor(activePosition.y / TILE_SIZE);
    this.updateTimeTrialAvailability(playerTileX, playerTileY);

    if (this.input.consumeTimeTrialMenu()) {
      if (this.raceMenuVisible) {
        this.closeRaceMenu();
      } else if (this.availableTimeTrial) {
        this.openRaceMenu(this.availableTimeTrial);
      }
    }
    if (this.input.consumeRaceMenu()) {
      if (this.raceMenuVisible && this.raceMenuMode === "aiRace") {
        this.closeRaceMenu();
      } else if (this.availableAiRace) {
        this.openRaceMenu(this.availableAiRace, "aiRace");
      }
    }

    if (this.activeTimeTrial && this.activeTimeTrial.isRunning) {
      const allowProgress = !this.paused && !raceMenuBlocking;
      this.updateActiveTimeTrialProgress(activePosition, allowProgress);
    }
    if (this.activeAiRace && this.activeAiRace.isRunning) {
      const allowRaceProgress = !this.paused && !raceMenuBlocking;
      this.updateActiveAiRace(activePosition, allowRaceProgress, delta);
    }
    const zoneType = getZone(
      Math.floor(activePosition.x / TILE_SIZE),
      Math.floor(activePosition.y / TILE_SIZE)
    );
    const zoneLabel = zoneType === "city" ? "City" : "Country";
    const carPhysics = this.vehicle.physics;
    const baseSpec = this.specDisplay || {};
    let hudExtras = {
      ...baseSpec,
      carLabel: this.carLabel,
      transmission: this.vehicle.getTransmissionLabel(),
      gear: this.vehicle.getDisplayGear(),
      rpm: null,
      throttle: null,
      brake: null,
      longG: null,
      latG: null
    };

    if (this.mode === "driving") {
      hudExtras = {
        ...hudExtras,
        rpm: carPhysics.engineRpm,
        throttle: carPhysics.throttle,
        brake: carPhysics.brake,
        longG: carPhysics.lastLongitudinalAccel / physicsLib.G,
        latG: carPhysics.lastLateralAccel / physicsLib.G
      };
    }

    this.hud.update({
      speed: activeEntity.getSpeed(),
      heading: activeEntity.getHeadingDegrees(),
      position: activePosition,
      zone: zoneLabel,
      collisions: this.vehicle.collisions,
      ...hudExtras
    });

    if (this.minimap) {
      this.minimap.update(this.level, activePosition, carPhysics.heading);
    }

    this.draw();
    this.lastTimestamp = timestamp;
    this.loopRunning = false;
  }

  toggleFullscreen() {
    const root = this.fullscreenRoot || this.canvas;
    if (!document.fullscreenElement) {
      if (root && typeof root.requestFullscreen === "function") {
        root.requestFullscreen().catch(() => {});
      } else if (this.canvas && typeof this.canvas.requestFullscreen === "function") {
        this.canvas.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    this.level.draw(ctx, this.camera, this.assets);
    if (this.traffic) {
      try {
        this.traffic.draw(ctx, this.camera, this.assets);
      } catch (_e) {}
    }
    this.vehicle.draw(ctx, this.camera, this.assets);
    if (Array.isArray(this.aiRaceOpponents) && this.aiRaceOpponents.length > 0) {
      for (const opponent of this.aiRaceOpponents) {
        opponent?.vehicle?.draw(ctx, this.camera, this.assets);
      }
    }
    this.player.draw(ctx, this.camera, this.assets);

    if (this.debug) {
      this.drawDebugColliders();
    }
  }

  updateTimeTrialAvailability(tileX, tileY) {
    if (
      !this.level ||
      this.mode !== "driving" ||
      this.paused ||
      this.raceMenuVisible ||
      this.raceCompleteVisible ||
      (this.activeTimeTrial && this.activeTimeTrial.isRunning) ||
      (this.activeAiRace && this.activeAiRace.isRunning)
    ) {
      if (this.availableTimeTrial) {
        this.availableTimeTrial = null;
        this.hideRaceHint();
      }
      if (this.availableAiRace) {
        this.availableAiRace = null;
      }
      return;
    }
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      if (this.availableTimeTrial) {
        this.availableTimeTrial = null;
        this.hideRaceHint();
      }
      if (this.availableAiRace) {
        this.availableAiRace = null;
      }
      return;
    }
    const trial = this.level.findTimeTrialStartAt(tileX, tileY);
    const race = !this.activeAiRace || !this.activeAiRace.isRunning
      ? this.level.findAiRaceStartAt(tileX, tileY)
      : null;

    const hintParts = [];
    if (trial) {
      this.availableTimeTrial = trial;
      hintParts.push(`Press 1 to start time trial (${trial.length} tiles)`);
    } else {
      if (this.availableTimeTrial) {
        this.availableTimeTrial = null;
      }
    }
    if (race) {
      this.availableAiRace = race;
      const rivals = race.opponentCount ?? AI_RACE_OPPONENT_COUNT;
      hintParts.push(`Press 2 to start AI race (${rivals} opponents)`);
    } else if (!race && this.availableAiRace && (!this.activeAiRace || !this.activeAiRace.isRunning)) {
      this.availableAiRace = null;
    }

    if (hintParts.length) {
      this.showRaceHint(hintParts.join(" • "), null, "prompt");
    } else if (this.raceHintMode !== "result" && this.raceHintMode !== "timer") {
      this.hideRaceHint();
    }
  }

  showRaceHint(message, autoHideMs = null, mode = null) {
    if (!this.raceHintEl) {
      return;
    }
    if (this.raceHintEl.textContent !== message) {
      this.raceHintEl.textContent = message;
    }
    this.raceHintEl.classList.remove("is-hidden");
    this.raceHintEl.setAttribute("aria-hidden", "false");
    if (this.raceHintTimeout) {
      clearTimeout(this.raceHintTimeout);
      this.raceHintTimeout = null;
    }
    if (Number.isFinite(autoHideMs) && autoHideMs > 0) {
      this.raceHintTimeout = setTimeout(() => this.hideRaceHint(), autoHideMs);
    }
    this.raceHintMode = mode;
  }

  hideRaceHint() {
    if (!this.raceHintEl) {
      return;
    }
    if (this.raceHintTimeout) {
      clearTimeout(this.raceHintTimeout);
      this.raceHintTimeout = null;
    }
    if (this.raceHintEl.classList.contains("is-hidden")) {
      return;
    }
    this.raceHintEl.classList.add("is-hidden");
    this.raceHintEl.setAttribute("aria-hidden", "true");
    this.raceHintMode = null;
  }

  openRaceMenu(event, mode = "timeTrial") {
    if (!event || !this.raceMenuEl) {
      return;
    }
    if (this.raceCompleteVisible) {
      this.hideRaceComplete();
    }
    this.raceMenuMode = mode;
    if (mode === "aiRace") {
      this.raceMenuRace = event;
      this.raceMenuTrial = null;
    } else {
      this.raceMenuTrial = event;
      this.raceMenuRace = null;
    }
    this.raceMenuVisible = true;
    const title =
      mode === "aiRace"
        ? `AI Race #${event.id}`
        : `Time Trial #${event.id}`;
    const checkpoints = Math.max(0, event.length - 2);
    const detail =
      mode === "aiRace"
        ? `${event.length} tiles • ${event.opponentCount ?? AI_RACE_OPPONENT_COUNT} opponents`
        : `${event.length} tiles • ${checkpoints} checkpoints`;
    if (this.raceMenuTitleEl) {
      this.raceMenuTitleEl.textContent = title;
    }
    if (this.raceMenuDetailEl) {
      this.raceMenuDetailEl.textContent = detail;
    }
    this.raceMenuEl.classList.remove("is-hidden");
    this.raceMenuEl.setAttribute("aria-hidden", "false");
    this.input.clearMovementState();
    this.hideRaceHint();
    if (this.raceMenuStartButton) {
      setTimeout(() => this.raceMenuStartButton?.focus(), 0);
    }
  }

  closeRaceMenu() {
    if (!this.raceMenuVisible) {
      return;
    }
    this.raceMenuVisible = false;
    if (this.raceMenuEl) {
      this.raceMenuEl.classList.add("is-hidden");
      this.raceMenuEl.setAttribute("aria-hidden", "true");
    }
    this.raceMenuTrial = null;
    this.raceMenuRace = null;
    this.raceMenuMode = "timeTrial";
  }

  confirmRaceStart() {
    if (this.raceMenuMode === "aiRace") {
      if (this.raceMenuRace) {
        this.startAiRace(this.raceMenuRace);
      }
      this.closeRaceMenu();
      return;
    }
    if (this.raceMenuTrial) {
      this.activateTimeTrial(this.raceMenuTrial);
    }
    this.closeRaceMenu();
  }

  showRaceComplete(event, mode = "timeTrial") {
    if (!this.raceCompleteEl || !event) {
      return;
    }
    this.raceCompleteVisible = true;
    this.raceCompleteMode = mode;
    if (mode === "aiRace") {
      this.raceCompleteRace = event;
      this.raceCompleteTrial = null;
    } else {
      this.raceCompleteTrial = event;
      this.raceCompleteRace = null;
    }
    const timeLabel = this.formatRaceTime(event.finishTime || 0);
    if (this.raceCompleteTimeEl) {
      this.raceCompleteTimeEl.textContent = timeLabel;
    }
    let summary;
    if (mode === "aiRace") {
      summary = this._formatAiRaceSummary(event);
    } else {
      const checkpoints = Math.max(0, event.checkpoints.length - 2);
      summary = `${event.length} tiles • ${checkpoints} checkpoints`;
    }
    if (this.raceCompleteSummaryEl) {
      this.raceCompleteSummaryEl.textContent = summary;
    }
    this.raceCompleteEl.classList.remove("is-hidden");
    this.raceCompleteEl.setAttribute("aria-hidden", "false");
    this.renderRaceCompleteLeaderboard(event, mode);
    this.hideRaceHint();
    if (this.raceCompleteCloseButton) {
      setTimeout(() => this.raceCompleteCloseButton?.focus(), 0);
    }
  }

  hideRaceComplete() {
    if (!this.raceCompleteVisible) {
      return;
    }
    this.raceCompleteVisible = false;
    if (this.raceCompleteEl) {
      this.raceCompleteEl.classList.add("is-hidden");
      this.raceCompleteEl.setAttribute("aria-hidden", "true");
    }
    this.raceCompleteTrial = null;
    this.raceCompleteRace = null;
    this.raceCompleteMode = "timeTrial";
  }

  activateTimeTrial(trial) {
    if (!trial) {
      return;
    }
    trial.isActive = true;
    trial.isRunning = true;
    trial.isCompleted = false;
    trial.currentIndex = trial.checkpoints.length > 1 ? 1 : 0;
    trial.elapsedTime = 0;
    trial.startedAt = this.nowMs();
    trial.lastTickTime = trial.startedAt;
    trial.checkpoints.forEach((cp, index) => {
      cp.reached = index === 0;
    });
    if (trial.checkpoints.length <= 1) {
      this.finishTimeTrial(trial);
      return;
    }
    this.activeTimeTrial = trial;
    if (this.availableTimeTrial === trial) {
      this.availableTimeTrial = null;
    }
    this.showRaceHint(
      `Time Trial: ${this.formatRaceTime(0)} • CP 0/${Math.max(1, trial.checkpoints.length - 1)}`,
      null,
      "timer"
    );
  }

  updateActiveTimeTrialProgress(position, advanceTime = true) {
    const trial = this.activeTimeTrial;
    if (!trial || !trial.isRunning) {
      return;
    }
    const now = this.nowMs();
    if (advanceTime) {
      const lastTick = trial.lastTickTime ?? now;
      trial.elapsedTime += Math.max(0, now - lastTick) / 1000;
      trial.lastTickTime = now;
    }
    const checkpointsRemaining = Math.max(0, trial.checkpoints.length - 1);
    if (advanceTime) {
      const checkpoint = trial.checkpoints[trial.currentIndex];
      if (checkpoint && this._isWithinCheckpoint(position, checkpoint)) {
        checkpoint.reached = true;
        trial.currentIndex += 1;
        if (trial.currentIndex >= trial.checkpoints.length) {
          this.finishTimeTrial(trial);
          return;
        }
      }
    }
    const reachedCount = Math.min(checkpointsRemaining, Math.max(0, trial.currentIndex - 1));
    const status = `Time Trial: ${this.formatRaceTime(trial.elapsedTime)} • CP ${reachedCount}/${checkpointsRemaining}`;
    this.showRaceHint(status, null, "timer");
  }

  finishTimeTrial(trial) {
    trial.isRunning = false;
    trial.isActive = false;
    trial.isCompleted = true;
    trial.finishTime = trial.elapsedTime;
    this.recordTimeTrialResult(trial);
    this.activeTimeTrial = null;
    const message = `Time Trial Complete: ${this.formatRaceTime(trial.finishTime || 0)}`;
    this.showRaceHint(message, 6000, "result");
    this.showRaceComplete(trial, "timeTrial");
  }

  formatRaceTime(seconds) {
    const totalMs = Math.max(0, seconds) * 1000;
    const minutes = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const millis = Math.floor(totalMs % 1000);
    return `${minutes}:${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  }

  _isWithinCheckpoint(position, checkpoint) {
    if (!checkpoint?.line) {
      return false;
    }
    const { distance } = this._distanceToSegment(position, checkpoint.line.start, checkpoint.line.end);
    const threshold = Math.max(20, TILE_SIZE * 0.1);
    return distance <= threshold;
  }

  startAiRace(race) {
    if (!race) {
      return;
    }
    race.isActive = true;
    race.isRunning = true;
    race.isCompleted = false;
    race.currentIndex = race.checkpoints.length > 1 ? 1 : 0;
    race.elapsedTime = 0;
    race.checkpoints.forEach((cp, index) => {
      cp.reached = index === 0;
    });
    this.activeAiRace = {
      event: race,
      elapsedTime: 0,
      lastTickTime: this.nowMs(),
      playerCheckpointIndex: race.checkpoints.length > 1 ? 1 : 0,
      playerFinished: false
    };
    this.availableAiRace = null;
    this.hideRaceHint();
    this.aiRaceResults = [];
    this.aiRaceOpponents = this._spawnAiOpponents(race);
  }

  updateActiveAiRace(position, advanceTime = true, delta = 0) {
    const raceState = this.activeAiRace;
    if (!raceState || !raceState.event || !raceState.event.isRunning) {
      return;
    }
    const now = this.nowMs();
    if (advanceTime) {
      const lastTick = raceState.lastTickTime ?? now;
      raceState.elapsedTime += Math.max(0, now - lastTick) / 1000;
    }
    raceState.lastTickTime = now;
    if (advanceTime) {
      this._updatePlayerRaceProgress(raceState, position);
    }
    this._updateAiOpponents(raceState, delta, advanceTime);
    if (advanceTime) {
      const race = raceState.event;
      const checkpointsRemaining = Math.max(0, race.checkpoints.length - 1);
      const reached = Math.min(checkpointsRemaining, Math.max(0, raceState.playerCheckpointIndex - 1));
      const status = `Race: ${this.formatRaceTime(raceState.elapsedTime)} • CP ${reached}/${checkpointsRemaining}`;
      this.showRaceHint(status, null, "timer");
    }
  }

  _updatePlayerRaceProgress(raceState, position) {
    const race = raceState.event;
    const checkpoints = race.checkpoints;
    const checkpoint = checkpoints[raceState.playerCheckpointIndex];
    if (!checkpoint) {
      this._completePlayerAiRace(raceState);
      return;
    }
    if (this._isWithinCheckpoint(position, checkpoint)) {
      checkpoint.reached = true;
      raceState.playerCheckpointIndex += 1;
      race.currentIndex = raceState.playerCheckpointIndex;
      if (raceState.playerCheckpointIndex >= checkpoints.length) {
        this._completePlayerAiRace(raceState);
      }
    } else {
      race.currentIndex = raceState.playerCheckpointIndex;
    }
  }

  _completePlayerAiRace(raceState) {
    if (!raceState || raceState.playerFinished) {
      return;
    }
    raceState.playerFinished = true;
    const finishTime = raceState.elapsedTime;
    raceState.event.finishTime = finishTime;
    this.aiRaceResults.push({
      carLabel: this.carLabel || "You",
      time: finishTime,
      isPlayer: true,
      timestamp: Date.now()
    });
    this._finalizeAiRaceIfDone(raceState);
  }

  _updateAiOpponents(raceState, delta, allowProgress) {
    if (!Array.isArray(this.aiRaceOpponents) || !allowProgress) {
      return;
    }
    for (const opponent of this.aiRaceOpponents) {
      this._updateSingleAiOpponent(raceState, opponent, delta);
    }
    this._finalizeAiRaceIfDone(raceState);
  }

  _updateSingleAiOpponent(raceState, opponent, delta) {
    if (!raceState?.event || !opponent || opponent.finished) {
      return;
    }
    const race = raceState.event;
    const vehicle = opponent.vehicle;
    if (!vehicle) {
      opponent.finished = true;
      return;
    }
    const checkpoint = race.checkpoints[opponent.checkpointIndex];
    if (!checkpoint) {
      this._completeAiOpponent(raceState, opponent);
      return;
    }
    const target = this._checkpointTargetPoint(checkpoint);
    if (!target) {
      opponent.checkpointIndex += 1;
      return;
    }
    const position = vehicle.getPosition();
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const desiredHeading = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(desiredHeading - vehicle.physics.heading);
    const input = {
      forward: true,
      reverse: false,
      left: angleDiff < -0.08,
      right: angleDiff > 0.08,
      brake: false,
      throttleScale: Math.abs(angleDiff) > Math.PI / 3 ? 0.35 : 1
    };
    const targetSpeed = opponent.targetSpeed ?? 20;
    const currentSpeed = vehicle.physics.getSpeedMetersPerSecond();
    if (currentSpeed > targetSpeed + 2) {
      input.brake = true;
    } else if (currentSpeed < targetSpeed - 1) {
      input.throttleScale = Math.max(input.throttleScale, 1);
    }
    vehicle.update(input, delta, this.level.bounds);
    const distance = Math.hypot(dx, dy);
    if (distance <= AI_RACE_CHECKPOINT_THRESHOLD) {
      opponent.checkpointIndex += 1;
      if (opponent.checkpointIndex >= race.checkpoints.length) {
        this._completeAiOpponent(raceState, opponent);
      }
    }
  }

  _completeAiOpponent(raceState, opponent) {
    if (!opponent || opponent.finished) {
      return;
    }
    opponent.finished = true;
    const finishTime = raceState.elapsedTime;
    opponent.finishTime = finishTime;
    this.aiRaceResults.push({
      carLabel: opponent.label || "Rival",
      time: finishTime,
      isPlayer: false,
      timestamp: Date.now()
    });
  }

  _finalizeAiRaceIfDone(raceState) {
    if (!raceState || !raceState.event) {
      return;
    }
    const allOpponentsFinished =
      Array.isArray(this.aiRaceOpponents) &&
      this.aiRaceOpponents.every((opponent) => opponent.finished);
    if (raceState.playerFinished && allOpponentsFinished) {
      this.finishAiRace(raceState);
    }
  }

  finishAiRace(raceState) {
    if (!raceState || !raceState.event) {
      return;
    }
    const race = raceState.event;
    race.isRunning = false;
    race.isActive = false;
    race.isCompleted = true;
    race.elapsedTime = raceState.elapsedTime;
    const sorted = this.aiRaceResults
      .slice()
      .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))
      .map((entry, index) => ({
        ...entry,
        placement: index + 1
      }));
    race.leaderboard = sorted.slice(0, 10);
    this.activeAiRace = null;
    this._cleanupAiRaceOpponents();
    const message = this.aiRaceResults.length
      ? `Race Complete: ${this.formatRaceTime(race.finishTime || 0)}`
      : "Race Complete";
    this.showRaceHint(message, 6000, "result");
    this.showRaceComplete(race, "aiRace");
  }

  _spawnAiOpponents(race) {
    this._cleanupAiRaceOpponents();
    if (!race) {
      return [];
    }
    const start = race.start?.world ?? race.checkpoints[0]?.world ?? {
      x: race.path?.[0]?.x * TILE_SIZE + TILE_SIZE / 2,
      y: race.path?.[0]?.y * TILE_SIZE + TILE_SIZE / 2
    };
    const headingDir = race.checkpoints?.[1]?.dir ?? race.checkpoints?.[0]?.dir ?? "E";
    const heading = directionToAngle(headingDir);
    const lateralAngle = heading + Math.PI / 2;
    const count = Math.max(1, race.opponentCount ?? AI_RACE_OPPONENT_COUNT);
    const opponents = [];
    for (let index = 0; index < count; index += 1) {
      const spec = CAR_CATALOG[(race.id + index) % CAR_CATALOG.length];
      const config = createCarConfigFromSpec(spec?.specs ?? {}, { carId: spec?.id });
      const laneOffset = ((index % 2 === 0 ? 1 : -1) * (Math.floor(index / 2) + 1) * 20);
      const backOffset = -index * 28;
      const spawnX = start.x + Math.cos(heading) * backOffset + Math.cos(lateralAngle) * laneOffset;
      const spawnY = start.y + Math.sin(heading) * backOffset + Math.sin(lateralAngle) * laneOffset;
      const vehicle = new Vehicle(
        this.system,
        { x: spawnX, y: spawnY, angle: heading },
        config,
        spec,
        { precomputedConfig: true, level: this.level }
      );
      vehicle.physics.setWorldPosition(spawnX, spawnY);
      vehicle.body.setPosition(spawnX, spawnY);
      vehicle.body.setAngle(heading);
      vehicle.physics.heading = heading;
      const opponent = {
        vehicle,
        checkpointIndex: race.checkpoints.length > 1 ? 1 : 0,
        finished: false,
        finishTime: null,
        label: spec ? formatCarLabel(spec) : `Rival ${index + 1}`,
        targetSpeed: 18 + Math.random() * 8
      };
      opponents.push(opponent);
    }
    return opponents;
  }

  _cleanupAiRaceOpponents() {
    if (!Array.isArray(this.aiRaceOpponents)) {
      this.aiRaceOpponents = [];
      return;
    }
    for (const opponent of this.aiRaceOpponents) {
      const body = opponent?.vehicle?.body;
      if (body && typeof this.system.remove === "function") {
        try {
          this.system.remove(body);
        } catch (_error) {}
      }
    }
    this.aiRaceOpponents = [];
  }

  _checkpointTargetPoint(checkpoint) {
    if (!checkpoint) {
      return null;
    }
    if (checkpoint.line?.start && checkpoint.line?.end) {
      return {
        x: (checkpoint.line.start.x + checkpoint.line.end.x) / 2,
        y: (checkpoint.line.start.y + checkpoint.line.end.y) / 2
      };
    }
    if (checkpoint.world) {
      return { x: checkpoint.world.x, y: checkpoint.world.y };
    }
    return null;
  }

  _distanceToSegment(point, start, end) {
    const segX = end.x - start.x;
    const segY = end.y - start.y;
    const segLenSq = segX * segX + segY * segY;
    if (segLenSq < 1e-6) {
      const dist = Math.hypot(point.x - start.x, point.y - start.y);
      return { distance: dist, t: 0 };
    }
    const t = ((point.x - start.x) * segX + (point.y - start.y) * segY) / segLenSq;
    const clampedT = Math.min(1, Math.max(0, t));
    const projX = start.x + segX * clampedT;
    const projY = start.y + segY * clampedT;
    const distance = Math.hypot(point.x - projX, point.y - projY);
    return { distance, t: clampedT };
  }

  nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  recordTimeTrialResult(trial) {
    if (!trial) {
      return;
    }
    if (!Array.isArray(trial.leaderboard)) {
      trial.leaderboard = [];
    }
    const carLabel =
      this.carLabel ||
      this.specDisplay?.carLabel ||
      this.vehicle?.carSpec?.name ||
      "Vehicle";
    const entry = {
      carLabel,
      carId: this.carSpec?.id ?? null,
      time: trial.finishTime ?? trial.elapsedTime ?? 0,
      timestamp: Date.now()
    };
    trial.leaderboard.push(entry);
    trial.leaderboard.sort((a, b) => a.time - b.time || a.timestamp - b.timestamp);
    if (trial.leaderboard.length > 10) {
      trial.leaderboard.length = 10;
    }
  }

  renderRaceCompleteLeaderboard(event, mode = "timeTrial") {
    if (!this.raceCompleteLeaderboardEl) {
      return;
    }
    this.raceCompleteLeaderboardEl.innerHTML = "";
    if (!event || !Array.isArray(event.leaderboard) || !event.leaderboard.length) {
      const li = document.createElement("li");
      li.textContent = "No recorded times.";
      this.raceCompleteLeaderboardEl.appendChild(li);
      return;
    }
    event.leaderboard.forEach((entry, index) => {
      const li = document.createElement("li");
      const placement = entry.placement ?? index + 1;
      const label = entry.isPlayer ? `${entry.carLabel || "You"} (You)` : entry.carLabel || `Racer ${placement}`;
      li.textContent = `${placement}. ${label} — ${this.formatRaceTime(entry.time)}`;
      this.raceCompleteLeaderboardEl.appendChild(li);
    });
  }

  _formatAiRaceSummary(race) {
    const rivals = Math.max(1, (race.opponentCount ?? AI_RACE_OPPONENT_COUNT));
    const playerEntry = Array.isArray(race.leaderboard)
      ? race.leaderboard.find((entry) => entry.isPlayer)
      : null;
    const placement = playerEntry?.placement ?? (race.leaderboard?.indexOf(playerEntry) ?? -1) + 1;
    const placementLabel = placement > 0 ? formatOrdinal(placement) : "Finished";
    return `${placementLabel} place • ${rivals} opponents`;
  }

  drawDebugColliders() {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    this.system.draw(ctx);
    ctx.stroke();
    ctx.restore();
  }

  resetVehicle({ preserveCollisions = false } = {}) {
    this.vehicle.reset({ preserveCollisions });
    this.mode = "driving";
    this.player.attachToVehicle(this.vehicle);
  }

  handleInteract() {
    if (this.mode === "driving") {
      if (this.vehicle.getSpeed() < 10) {
        this.exitVehicle();
      }
      return;
    }

    const dx = this.vehicle.body.x - this.player.body.x;
    const dy = this.vehicle.body.y - this.player.body.y;
    const distance = Math.hypot(dx, dy);
    if (distance < TILE_SIZE * 0.9 && this.vehicle.getSpeed() < 10) {
      this.enterVehicle();
    }
  }

  enterVehicle() {
    this.mode = "driving";
    this.vehicle.physics.stop();
    this.player.attachToVehicle(this.vehicle);
  }

  exitVehicle() {
    this.mode = "onFoot";
    this.vehicle.physics.stop();
    const angle = this.vehicle.body.angle;
    const offsetDistance = this.vehicle.bodyWidth * 0.9;
    const offset = {
      x: -Math.sin(angle) * offsetDistance,
      y: Math.cos(angle) * offsetDistance
    };
    this.player.detachFromVehicle(this.vehicle, offset);
    this.system.separateBody(this.player.body, () => true);
  }
}
async function bootstrap() {
  const canvas = document.getElementById("viewport");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element with id 'viewport' is missing.");
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to acquire 2D rendering context.");
  }

  const resizeCanvasToDisplaySize = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    } else {
      if (statCar) {
        statCar.textContent = "-";
      }
      if (statPower) {
        statPower.textContent = "-";
      }
      if (statMass) {
        statMass.textContent = "-";
      }
    }
  };

  resizeCanvasToDisplaySize();
  window.addEventListener("resize", resizeCanvasToDisplaySize);

  const assets = await loadImages(IMAGE_SOURCES);
  const hud = new HUD();
  hud.setDashboardVisible(false);
  let game = null;
  if (typeof globalThis !== "undefined") {
    globalThis.__rockportGame = null;
  }
  const resetButton = document.getElementById("reset-button");
  const debugToggle = document.getElementById("debug-toggle");
  const carSelect = document.getElementById("car-select");
  const startButton = document.getElementById("start-button");
  const carSummary = document.getElementById("car-summary");
  const minimapCanvas = document.getElementById("minimap");
  const dashCluster = document.getElementById("dash-cluster");
  const pauseOverlay = document.getElementById("pause-overlay");
  const resumeSaveButton = document.getElementById("resume-save-button");
  const savegameHint = document.getElementById("savegame-hint");
  const mainMenuOverlay = document.getElementById("main-menu-overlay");
  const menuNewGameButton = document.getElementById("menu-new-game");
  const menuCloseButton = document.getElementById("menu-close-button");
  const saveSlotList = document.getElementById("save-slot-list");
  const noSavesMessage = document.getElementById("no-saves-message");
  const saveFeatureAvailable = Boolean(getSaveStorage());
  let saveSlots = [];
  let latestSave = null;
  let cachedSlotMap = new Map();

  const findCarById = (id) => {
    if (id == null) {
      return null;
    }
    const needle = String(id);
    return CAR_CATALOG.find((car) => String(car.id) === needle) ?? null;
  };

  const refreshSaveSlots = () => {
    if (!saveFeatureAvailable) {
      saveSlots = [];
      latestSave = null;
      cachedSlotMap = new Map();
      return;
    }
    saveSlots = listSaveSlots();
    latestSave = saveSlots.length > 0 ? saveSlots[0] : null;
    cachedSlotMap = new Map(saveSlots.map((slot) => [String(slot.id), slot]));
  };

  const renderSaveSlotList = () => {
    if (!saveSlotList) {
      return;
    }
    saveSlotList.innerHTML = "";
    if (!saveFeatureAvailable) {
      if (noSavesMessage) {
        noSavesMessage.textContent = "Saving is unavailable in this environment.";
        noSavesMessage.classList.remove("is-hidden");
      }
      return;
    }
    if (saveSlots.length === 0) {
      if (noSavesMessage) {
        noSavesMessage.textContent = "No saved games yet.";
        noSavesMessage.classList.remove("is-hidden");
      }
      return;
    }
    if (noSavesMessage) {
      noSavesMessage.classList.add("is-hidden");
    }
    const fragment = document.createDocumentFragment();
    saveSlots.forEach((slot) => {
      const item = document.createElement("li");
      item.className = "save-slot";
      item.dataset.slotId = String(slot.id);

      const loadButton = document.createElement("button");
      loadButton.type = "button";
      loadButton.className = "save-slot-load";
      loadButton.dataset.action = "load";
      loadButton.dataset.slotId = String(slot.id);

      const nameEl = document.createElement("span");
      nameEl.className = "slot-name";
      nameEl.textContent = slot.name || slot.carLabel || "Saved Game";

      const metaEl = document.createElement("span");
      metaEl.className = "slot-meta";
      const timestamp = formatSaveTimestamp(slot.savedAt);
      const metaParts = [];
      if (timestamp) {
        metaParts.push(timestamp);
      }
      if (slot.carLabel) {
        metaParts.push(slot.carLabel);
      }
      metaParts.push(slot.mode === "onFoot" ? "On Foot" : "Driving");
      metaEl.textContent = metaParts.join(" • ");

      loadButton.appendChild(nameEl);
      loadButton.appendChild(metaEl);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "button-ghost save-slot-delete";
      deleteButton.dataset.action = "delete";
      deleteButton.dataset.slotId = String(slot.id);
      deleteButton.setAttribute("aria-label", `Delete ${slot.name || "saved game"}`);
      deleteButton.textContent = "Delete";

      item.appendChild(loadButton);
      item.appendChild(deleteButton);
      fragment.appendChild(item);
    });
    saveSlotList.appendChild(fragment);
  };

  const updateSaveUi = () => {
    if (!saveFeatureAvailable) {
      saveSlots = [];
      latestSave = null;
      cachedSlotMap = new Map();
      if (resumeSaveButton) {
        resumeSaveButton.classList.add("is-hidden");
        resumeSaveButton.disabled = true;
      }
      if (savegameHint) {
        savegameHint.textContent = "";
        savegameHint.classList.add("is-hidden");
      }
      renderSaveSlotList();
      return;
    }
    refreshSaveSlots();
    renderSaveSlotList();
    const hasSlots = saveSlots.length > 0;
    if (resumeSaveButton) {
      const canShow = hasSlots && !game;
      resumeSaveButton.textContent = "Load Saved Game";
      resumeSaveButton.disabled = !canShow;
      resumeSaveButton.classList.toggle("is-hidden", !canShow);
    }
    if (savegameHint) {
      if (!hasSlots) {
        savegameHint.textContent = "";
        savegameHint.classList.add("is-hidden");
      } else {
        const slot = latestSave;
        const timestamp = formatSaveTimestamp(slot.savedAt);
        const parts = [];
        if (timestamp) {
          parts.push(`Last saved ${timestamp}`);
        }
        if (slot.carLabel) {
          parts.push(slot.carLabel);
        }
        parts.push(slot.mode === "onFoot" ? "On Foot" : "Driving");
        savegameHint.textContent = parts.join(" · ");
        savegameHint.classList.remove("is-hidden");
      }
    }
  };

  const hideMainMenu = () => {
    if (!mainMenuOverlay) {
      return;
    }
    mainMenuOverlay.classList.add("is-hidden");
    mainMenuOverlay.setAttribute("aria-hidden", "true");
  };

  const showMainMenu = ({ initial = false, focusLoad = false } = {}) => {
    if (!mainMenuOverlay) {
      return;
    }
    updateSaveUi();
    mainMenuOverlay.classList.remove("is-hidden");
    mainMenuOverlay.setAttribute("aria-hidden", "false");
    if (menuCloseButton) {
      menuCloseButton.classList.toggle("is-hidden", initial);
    }
    if (initial) {
      if (focusLoad && saveSlotList) {
        const firstLoadButton = saveSlotList.querySelector('[data-action="load"]');
        if (firstLoadButton) {
          firstLoadButton.focus();
          return;
        }
      }
      menuNewGameButton?.focus();
      return;
    }
    if (focusLoad && saveSlotList) {
      const firstLoadButton = saveSlotList.querySelector('[data-action="load"]');
      if (firstLoadButton) {
        firstLoadButton.focus();
        return;
      }
    }
    menuNewGameButton?.focus();
  };

  const handleSavedGame = (_slot = null) => {
    refreshSaveSlots();
    updateSaveUi();
  };

  const beginSession = ({ carSpec, carConfig, specDisplay, saveState } = {}) => {
    if (!carSpec) {
      return;
    }
    if (game) {
      game.stop();
      game = null;
      if (typeof globalThis !== "undefined") {
        globalThis.__rockportGame = null;
      }
    }
    const resolvedConfig = carConfig
      ? cloneCarConfig(carConfig)
      : createCarConfigFromSpec(carSpec.specs ?? {}, { carId: carSpec.id });
    const resolvedSpecDisplay = specDisplay ?? buildSpecDisplay(resolvedConfig, carSpec);
    const handleExitToMenu = () => {
      if (pauseOverlay) {
        pauseOverlay.classList.add("is-hidden");
      }
      if (minimapCanvas) {
        minimapCanvas.classList.add("is-hidden");
      }
      if (dashCluster) {
        dashCluster.classList.add("is-hidden");
      }
      hud.setVisible(true);
      hud.setDashboardVisible(false);
      if (startButton) {
        startButton.disabled = !selectedCar;
        startButton.textContent = "Load Vehicle";
      }
      if (carSelect) {
        carSelect.disabled = false;
      }
      game = null;
      if (typeof globalThis !== "undefined") {
        globalThis.__rockportGame = null;
      }
      showMainMenu({ initial: false, focusLoad: true });
      updateCarSummary();
      updateSaveUi();
    };
    const knownCar = findCarById(carSpec.id);
    if (knownCar) {
      selectedCar = knownCar;
    } else {
      selectedCar = carSpec;
    }
    game = new Game(canvas, ctx, assets, {
      carSpec,
      carConfig: resolvedConfig,
      hud,
      specDisplay: resolvedSpecDisplay,
      onExit: handleExitToMenu,
      onSaved: handleSavedGame
    });
    if (typeof globalThis !== "undefined") {
      globalThis.__rockportGame = game;
    }
    if (debugToggle) {
      game.debug = debugToggle.checked;
    }
    const payload = saveState && typeof saveState === "object" ? saveState.data ?? saveState : null;
    if (payload) {
      game.applySaveState(payload);
    }
    game.start();
    if (startButton) {
      startButton.disabled = true;
      startButton.textContent = "Driving…";
    }
    if (carSelect) {
      carSelect.disabled = true;
    }
    hideMainMenu();
    updateSaveUi();
  };

  refreshSaveSlots();

  if (carSummary) {
    carSummary.textContent = "Checking vehicle performance, please wait...";
  }
  if (startButton) {
    startButton.disabled = true;
    startButton.textContent = "Load Vehicle";
  }
  if (carSelect) {
    carSelect.disabled = true;
  }

  const visualizer =
    carVerificationManager && assets ? new CalibrationVisualizer(canvas, ctx, assets) : null;
  const calibrationOptions = { visualizer };
  let overrides = globalThis.ROCKPORT_CALIBRATION_OPTIONS;
  if (!overrides) {
    try {
      const stored = globalThis.localStorage?.getItem?.("rockport.calibration.options");
      if (stored) {
        overrides = JSON.parse(stored);
      }
    } catch (_error) {
      overrides = null;
    }
  }
  if (overrides && typeof overrides === "object") {
    Object.assign(calibrationOptions, overrides);
  }

  if (carVerificationManager) {
    try {
      await carVerificationManager.verifyAllCars(CAR_CATALOG, calibrationOptions);
    } catch (error) {
      console.error("Vehicle verification encountered an unexpected error.", error);
    }
  }

  try {
    if (visualizer) {
      visualizer.clear();
    }
  } catch (visualError) {
    console.warn("Unable to finalize calibration visualization.", visualError);
  }

  const savedCarSpec = latestSave ? findCarById(latestSave.carId) : null;
  let selectedCar = savedCarSpec ?? (CAR_CATALOG.length > 0 ? CAR_CATALOG[0] : null);
  let selectedSpecDisplay = null;

  const updateCarSummary = () => {
    if (carSummary) {
      carSummary.textContent = buildCarSummary(selectedCar);
    }
    if (selectedCar && selectedCar.specs) {
      const previewConfig = createCarConfigFromSpec(selectedCar.specs, { carId: selectedCar.id });
      selectedSpecDisplay = buildSpecDisplay(previewConfig, selectedCar);
      hud.applyStaticSpec(selectedSpecDisplay);
    } else {
      selectedSpecDisplay = null;
      hud.applyStaticSpec({});
    }
  };

  if (carSelect) {
    carSelect.innerHTML = "";
    CAR_CATALOG.forEach((car) => {
      const option = document.createElement("option");
      option.value = car.id;
      option.textContent = formatCarLabel(car);
      carSelect.appendChild(option);
    });
    carSelect.addEventListener("change", (event) => {
      const target = event.target;
      const value = target.value;
      selectedCar = CAR_CATALOG.find((car) => car.id === value) ?? null;
      updateCarSummary();
      if (startButton) {
        startButton.disabled = !selectedCar;
      }
    });
    const initialSelection =
      selectedCar && findCarById(selectedCar.id) ? selectedCar : CAR_CATALOG[0] ?? null;
    if (initialSelection) {
      carSelect.value = initialSelection.id;
      selectedCar = initialSelection;
    } else {
      carSelect.value = "";
      selectedCar = null;
    }
    carSelect.disabled = false;
  }

  updateCarSummary();
  updateSaveUi();
  showMainMenu({ initial: true, focusLoad: saveSlots.length > 0 });

  if (startButton) {
    startButton.disabled = !selectedCar;
    startButton.addEventListener("click", () => {
      if (!selectedCar) {
        return;
      }
      const config = createCarConfigFromSpec(selectedCar.specs, { carId: selectedCar.id });
      const specDisplay = selectedSpecDisplay ?? buildSpecDisplay(config, selectedCar);
      beginSession({
        carSpec: selectedCar,
        carConfig: config,
        specDisplay,
        saveState: null
      });
    });
  }

  if (resumeSaveButton) {
    if (saveFeatureAvailable) {
      resumeSaveButton.addEventListener("click", () => {
        showMainMenu({ initial: false, focusLoad: true });
      });
    } else {
      resumeSaveButton.classList.add("is-hidden");
      resumeSaveButton.disabled = true;
    }
  }

  if (menuNewGameButton) {
    menuNewGameButton.addEventListener("click", () => {
      hideMainMenu();
      carSelect?.focus();
    });
  }

  if (menuCloseButton) {
    menuCloseButton.addEventListener("click", () => {
      hideMainMenu();
      resumeSaveButton?.focus();
    });
  }

  if (saveSlotList) {
    saveSlotList.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-action]") : null;
      if (!button) {
        return;
      }
      const slotId = Number.parseInt(button.dataset.slotId ?? "", 10);
      if (!Number.isFinite(slotId)) {
        return;
      }
      if (button.dataset.action === "delete") {
        const slot = cachedSlotMap.get(String(slotId)) || getSaveSlot(slotId);
        const label = slot?.name || "this saved game";
        const confirmed =
          typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm(`Delete "${label}"?`)
            : true;
        if (!confirmed) {
          return;
        }
        if (removeSaveSlot(slotId)) {
          refreshSaveSlots();
          renderSaveSlotList();
          updateSaveUi();
        } else {
          updateSaveUi();
        }
        return;
      }
      if (button.dataset.action === "load") {
        const slot = cachedSlotMap.get(String(slotId)) || getSaveSlot(slotId);
        if (!slot || !slot.data) {
          updateSaveUi();
          return;
        }
        const payload = slot.data;
        const catalogCar = payload.carId ? findCarById(payload.carId) : null;
        let resumeSpec;
        if (catalogCar) {
          resumeSpec = { ...catalogCar };
          resumeSpec.specs = catalogCar.specs ? { ...catalogCar.specs } : {};
        } else {
          resumeSpec = {
            id: payload.carId ?? `saved-vehicle-${slot.id}`,
            make: slot.carLabel ?? "Saved Vehicle",
            model: "",
            variant: "",
            year: null,
            country: null,
            specs: cloneCarConfig(payload.carConfig ?? {})
          };
        }
        if (!resumeSpec.specs || Object.keys(resumeSpec.specs).length === 0) {
          resumeSpec.specs = cloneCarConfig(payload.carConfig ?? {});
        }
        const config = cloneCarConfig(payload.carConfig ?? resumeSpec.specs ?? {});
        const specDisplay = buildSpecDisplay(config, resumeSpec);
        beginSession({
          carSpec: resumeSpec,
          carConfig: config,
          specDisplay,
          saveState: slot
        });
      }
    });
  }

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      if (game) {
        game.resetVehicle({ preserveCollisions: false });
      }
    });
  }

  if (debugToggle) {
    debugToggle.addEventListener("change", (event) => {
      if (game) {
        game.debug = event.target.checked;
      }
    });
  }
}

if (typeof document !== "undefined") {
  bootstrap().catch((error) => {
    console.error(error);
  });
} else {
  globalThis.RockportCalibration = {
    manager: carVerificationManager,
    verifyAllCars(cars = globalThis.RockportCarCatalog, options = {}) {
      return carVerificationManager.verifyAllCars(cars, options);
    },
    createCarConfigFromSpec,
    CarVerificationManager
  };
}
})();

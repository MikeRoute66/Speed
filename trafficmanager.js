// --- TrafficManager (replacement) ---
/*
  TrafficManager: spawn traffic per road
  - TRAFFIC_PER_ROAD constant controls number of cars spawned per road (set to 3)
  - When started, scans known horizontal rows and vertical columns from Level and spawns
    TRAFFIC_PER_ROAD vehicles per detected road, spaced along that road with light jitter.
  - Vehicles are created using existing Vehicle constructor and precomputed car config,
    choosing candidates from CAR_CATALOG filtered by allowed sprites.
*/
class TrafficManager {
  constructor(system, level, assets, player, playerVehicle) {
    this.system = system;
    this.level = level;
    this.assets = assets;
    this.player = player;
    this.playerVehicle = playerVehicle;
    this.vehicles = []; // { veh, state }
    this.enabled = true;

    // New configuration: number of traffic cars per road
    this.TRAFFIC_PER_ROAD = 3;

    this.allowedSpriteKeys = new Set(["car_Sedan", "car_Hatchback", "car_Truck"]);
    this.prevTileKey = new Map();
  }

  start() {
    this.enabled = true;
    // Clear any preexisting NPCs (defensive)
    this.stop();
    // Spawn traffic based on roads present in the Level
    this.spawnTrafficPerRoad();
  }

  stop() {
    this.enabled = false;
    // remove bodies (best-effort)
    for (const entry of this.vehicles) {
      try {
        const v = entry.veh;
        if (v && v.body && typeof this.system.remove === "function") {
          this.system.remove(v.body);
        }
      } catch (_e) {}
    }
    this.vehicles.length = 0;
    this.prevTileKey.clear();
  }

  // Build candidate car list filtered by allowed sprites
  _buildCandidates() {
    const candidates = CAR_CATALOG.filter((c) => {
      try {
        const key = chooseCarSprite(c);
        return this.allowedSpriteKeys.has(key);
      } catch (_e) {
        return false;
      }
    });
    return candidates.length > 0 ? candidates : null;
  }

  // Spawn TRAFFIC_PER_ROAD vehicles for each detected horizontal row and vertical column.
  spawnTrafficPerRoad() {
    const candidates = this._buildCandidates();
    if (!candidates) return;

    // Helper to spawn a single vehicle at world tile coordinates (tileX, tileY) with world offsets in pixels
    const spawnAt = (worldX, worldY, heading) => {
      const carSpec = candidates[Math.floor(Math.random() * candidates.length)];
      const config = createCarConfigFromSpec(carSpec?.specs ?? {}, { carId: carSpec?.id });
      // Create a spawn pose in pixels. Use small random jitter so cars don't perfectly overlap.
      const jitterX = (Math.random() - 0.5) * TILE_SIZE * 0.4;
      const jitterY = (Math.random() - 0.5) * TILE_SIZE * 0.4;
      const spawnPose = { x: worldX + jitterX, y: worldY + jitterY, angle: heading };
      const veh = new Vehicle(this.system, spawnPose, config, carSpec, { precomputedConfig: true });
      if (Math.random() < 0.1) {
        veh.setTransmissionMode("manual");
      }
      this.vehicles.push({ veh, state: { turnChoice: null } });
    };

    // Spawn along horizontal rows: level.horizontalRows contains tile Y values
    for (const rowY of this.level.horizontalRows) {
      // estimate road extents by counting continuous road tiles across some span
      // We'll sample positions across a chunk area to find tiles that belong to this row
      // and select SPOTS evenly spaced across visible region.
      // Convert tile row (y) to world Y in pixels:
      const worldY = rowY * TILE_SIZE + TILE_SIZE / 2;
      // Find reasonable X span: look for road tiles in a broad range near origin
      const startXtile = -ZONE_SIZE;
      const endXtile = ZONE_SIZE;
      // We'll compute positions evenly spaced across the span
      const spots = this.TRAFFIC_PER_ROAD;
      for (let i = 0; i < spots; i += 1) {
        const t = (i + 1) / (spots + 1);
        const worldX = (startXtile + (endXtile - startXtile) * t) * TILE_SIZE + TILE_SIZE / 2;
        // Heading along horizontal roads: east (0) or west (PI). Randomize direction per vehicle.
        const heading = Math.random() < 0.5 ? 0 : Math.PI;
        spawnAt(worldX, worldY, heading);
      }
    }

    // Spawn along vertical columns: level.verticalColumns contains tile X values
    for (const colX of this.level.verticalColumns) {
      const worldX = colX * TILE_SIZE + TILE_SIZE / 2;
      const startYtile = -ZONE_SIZE;
      const endYtile = ZONE_SIZE;
      const spots = this.TRAFFIC_PER_ROAD;
      for (let i = 0; i < spots; i += 1) {
        const t = (i + 1) / (spots + 1);
        const worldY = (startYtile + (endYtile - startYtile) * t) * TILE_SIZE + TILE_SIZE / 2;
        // Heading along vertical roads: south (PI/2) or north (-PI/2)
        const heading = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
        spawnAt(worldX, worldY, heading);
      }
    }
  }

  // Legacy spawnTraffic(count) kept to preserve compatibility (keeps original random spawn behavior).
  spawnTraffic(count) {
    // fallback behavior (preserve old random spawn method)
    const candidates = this._buildCandidates();
    if (!candidates) return;
    const origin = this.level.startPose || { x: TILE_SIZE * 4, y: TILE_SIZE * 4, angle: 0 };
    for (let i = 0; i < count; i += 1) {
      const carSpec = candidates[Math.floor(Math.random() * candidates.length)];
      const offsetX = (Math.random() - 0.5) * TILE_SIZE * 6;
      const offsetY = (Math.random() - 0.5) * TILE_SIZE * 6;
      const spawnPose = { x: origin.x + offsetX, y: origin.y + offsetY, angle: Math.random() * Math.PI * 2 };
      const config = createCarConfigFromSpec(carSpec?.specs ?? {}, { carId: carSpec?.id });
      const veh = new Vehicle(this.system, spawnPose, config, carSpec, { precomputedConfig: true });
      if (Math.random() < 0.1) {
        veh.setTransmissionMode("manual");
      }
      this.vehicles.push({ veh, state: { turnChoice: null } });
    }
  }

  update(dt) {
    if (!this.enabled) return;
    const bounds = this.level.bounds;
    for (const entry of this.vehicles) {
      const veh = entry.veh;
      const pos = veh.getPosition();
      const tileX = Math.floor(pos.x / TILE_SIZE);
      const tileY = Math.floor(pos.y / TILE_SIZE);
      const tile = this.level.getTile(tileX, tileY) || {};
      const tileKey = `${tileX},${tileY}`;

      const prev = this.prevTileKey.get(veh) || null;
      if (prev !== tileKey) {
        this.prevTileKey.set(veh, tileKey);
        if (tile.code === "I") {
          const r = Math.random();
          if (r < 0.33) entry.state.turnChoice = "left";
          else if (r < 0.66) entry.state.turnChoice = "straight";
          else entry.state.turnChoice = "right";
        } else {
          entry.state.turnChoice = "straight";
        }
      }

      // Steering to align with tile grid and respect chosen turn
      let desiredHeading = veh.physics.heading;
      if (["R", "V", "I"].includes(tile.code)) {
        const rounded = Math.round(veh.physics.heading / (Math.PI / 2)) * (Math.PI / 2);
        desiredHeading = rounded;
        if (entry.state.turnChoice === "left") desiredHeading -= Math.PI / 2;
        if (entry.state.turnChoice === "right") desiredHeading += Math.PI / 2;
      }

      while (desiredHeading <= -Math.PI) desiredHeading += Math.PI * 2;
      while (desiredHeading > Math.PI) desiredHeading -= Math.PI * 2;

      const angleDiff = desiredHeading - veh.physics.heading;
      const steerLeft = angleDiff < -0.08;
      const steerRight = angleDiff > 0.08;

      const input = {
        forward: true,
        reverse: false,
        left: steerLeft,
        right: steerRight,
        brake: false
      };

      // slow down near player
      const playerPos = this.player.getPosition();
      const dx = playerPos.x - pos.x;
      const dy = playerPos.y - pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < TILE_SIZE * 1.2) {
        input.forward = false;
        input.brake = true;
      }

      veh.update(input, dt, bounds);
    }
  }

  draw(ctx, camera, assets) {
    for (const entry of this.vehicles) {
      entry.veh.draw(ctx, camera, assets);
    }
  }
}
// --- end replacement ---

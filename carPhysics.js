(() => {
  const G = 9.81;
  const AIR_DENSITY = 1.225;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sign(value) {
    if (value > 0) return 1;
    if (value < 0) return -1;
    return 0;
  }

  function createVector(x = 0, y = 0) {
    return { x, y };
  }

  function copyVector(vector) {
    return { x: vector.x, y: vector.y };
  }

  function setVector(vector, x, y) {
    vector.x = x;
    vector.y = y;
    return vector;
  }

  function addVectorInPlace(target, source) {
    target.x += source.x;
    target.y += source.y;
    return target;
  }

  function addScaledInPlace(target, source, scale) {
    target.x += source.x * scale;
    target.y += source.y * scale;
    return target;
  }

  function scaleInPlace(vector, scale) {
    vector.x *= scale;
    vector.y *= scale;
    return vector;
  }

  function length(vector) {
    return Math.hypot(vector.x, vector.y);
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y;
  }

  function normalize(vector) {
    const len = length(vector);
    if (len < 1e-9) {
      return { x: 0, y: 0 };
    }
    return { x: vector.x / len, y: vector.y / len };
  }

  class Tire {
    constructor(name, gripCoefficient) {
      this.name = name;
      this.gripCoefficient = gripCoefficient;
      this.hasTraction = true;
      this.normalLoad = 0;
      this.combinedForce = createVector();
    }
  }

  function defaultCarConfig() {
    return {
      massKg: 1450,
      driveType: "RWD",
      gearRatios: [0.0, 3.54, 2.12, 1.49, 1.21, 1.0, 0.84],
      finalDriveRatio: 3.42,
      horsepower: 420,
      peakTorqueNm: 530,
      brakeHorsepower: 360,
      dragCoefficient: 0.32,
      downforceCoefficient: 1.1,
      frontalAreaM2: 2.2,
      wheelRadiusM: 0.32,
      tireGrips: [1.05, 1.05, 1.1, 1.1],
      tireLateralGrips: null,
      tireLateralGripFactor: 1.12,
      brakeTorquePerWheelNm: [4200, 4200, 3200, 3200],
      brakeBiasFront: 0.6,
      wheelbaseM: 2.8,
      cgHeightM: 0.55,
      trackWidthM: 1.55,
      frontWeightDistribution: 0.52,
      drivetrainEfficiency: 0.9,
      rollingResistanceCoeff: 0.015
    };
  }

  class Car {
    constructor(config, options = {}) {
      this.config = {
        ...defaultCarConfig(),
        ...config
      };
      this.pixelsPerMeter = options.pixelsPerMeter ?? 16;

      const startPosition = options.position ?? { x: 0, y: 0 };
      const startHeading = options.heading ?? 0;
      this.position = createVector(
        startPosition.x / this.pixelsPerMeter,
        startPosition.y / this.pixelsPerMeter
      );
      this.velocity = createVector();
      this.heading = startHeading;
      this.angularVelocity = 0;
      this.steerAngle = 0;

      this.longitudinalGripCoeffs = Array.isArray(this.config.tireGrips)
        ? this.config.tireGrips.slice()
        : defaultCarConfig().tireGrips.slice();
      const latSource = this.config.tireLateralGrips;
      const lateralFactor = Number.isFinite(this.config.tireLateralGripFactor)
        ? Math.max(1.02, this.config.tireLateralGripFactor)
        : 1.12;
      if (Array.isArray(latSource) && latSource.length >= 4) {
        this.lateralGripCoeffs = latSource.slice(0, 4);
      } else if (Array.isArray(latSource) && latSource.length > 0) {
        this.lateralGripCoeffs = this.longitudinalGripCoeffs.map(
          (_value, index) => latSource[index % latSource.length]
        );
      } else {
        this.lateralGripCoeffs = this.longitudinalGripCoeffs.map(
          (value) => value * lateralFactor
        );
      }

      this.tires = [
        new Tire("Front-Left", this.longitudinalGripCoeffs[0]),
        new Tire("Front-Right", this.longitudinalGripCoeffs[1]),
        new Tire("Rear-Left", this.longitudinalGripCoeffs[2]),
        new Tire("Rear-Right", this.longitudinalGripCoeffs[3])
      ];
      this.gearIndex = Math.min(1, this.config.gearRatios.length - 1);
      this.idleRpm = 900;
      this.peakRpm = Math.max(
        2500,
        ((this.config.horsepower * 745.7) / (this.config.peakTorqueNm + 1e-6)) * (60 / (2 * Math.PI))
      );
      this.redlineRpm = this.peakRpm * 1.15;
      this.upshiftRpm = this.redlineRpm * 0.95;
      this.downshiftRpm = this.peakRpm * 0.6;
      this.engineRpm = this.idleRpm;
      this.throttle = 0;
      this.brake = 0;

      this.driveSplitFront = 0;
      this.driveSplitRear = 1;
      if (this.config.driveType.toUpperCase() === "FWD") {
        this.driveSplitFront = 1;
        this.driveSplitRear = 0;
      } else if (this.config.driveType.toUpperCase() === "AWD") {
        this.driveSplitFront = 0.45;
        this.driveSplitRear = 0.55;
      }

      this.lf = this.config.wheelbaseM * this.config.frontWeightDistribution;
      this.lr = this.config.wheelbaseM - this.lf;
      this.inertia =
        (this.config.massKg * (this.config.wheelbaseM ** 2 + this.config.trackWidthM ** 2)) / 12;
      this.lastLongitudinalAccel = 0;
      this.lastLateralAccel = 0;
      this.reverseMode = false;
      this.manualMode = options.manualMode ?? false;
      const firstDriveIndex = this.config.gearRatios.length > 1 ? 1 : 0;
      const firstDriveRatio = this.config.gearRatios[firstDriveIndex] ?? 0;
      this.reverseGearRatio = Math.abs(firstDriveRatio);
      this.revLimiterRpm = config.revLimiterRpm ?? 7000;
      if (Number.isFinite(this.revLimiterRpm) && this.revLimiterRpm > 0) {
        const limiter = this.revLimiterRpm;
        this.redlineRpm = Math.min(this.redlineRpm, limiter * 0.995);
        this.upshiftRpm = Math.min(this.upshiftRpm, limiter * 0.97);
        if (this.downshiftRpm >= this.upshiftRpm) {
          this.downshiftRpm = this.upshiftRpm * 0.55;
        }
      }
      this.revLimiterActive = false;
      this.brakeBiasFront = this.config.brakeBiasFront ?? 0.6;
      const fallbackBrakeTorque = (() => {
        const wheelRadius = this.config.wheelRadiusM ?? 0.3;
        const brakeHp = this.config.brakeHorsepower ?? 360;
        const totalForce = (brakeHp * 745.7) / 30;
        const frontForce = totalForce * this.brakeBiasFront;
        const rearForce = totalForce - frontForce;
        const frontTorque = (frontForce / 2) * wheelRadius;
        const rearTorque = (rearForce / 2) * wheelRadius;
        return [frontTorque, frontTorque, rearTorque, rearTorque];
      })();
      if (Array.isArray(this.config.brakeTorquePerWheelNm) && this.config.brakeTorquePerWheelNm.length >= 4) {
        this.brakeTorquePerWheelNm = this.config.brakeTorquePerWheelNm.slice(0, 4);
      } else {
        this.brakeTorquePerWheelNm = fallbackBrakeTorque;
      }
    }

    forwardVector() {
      return {
        x: Math.cos(this.heading),
        y: Math.sin(this.heading)
      };
    }

    rightVector() {
      const forward = this.forwardVector();
      return { x: -forward.y, y: forward.x };
    }

    setWorldPosition(x, y) {
      this.position.x = x / this.pixelsPerMeter;
      this.position.y = y / this.pixelsPerMeter;
    }

    applyWorldDisplacement(dx, dy) {
      this.position.x += dx / this.pixelsPerMeter;
      this.position.y += dy / this.pixelsPerMeter;
    }

    resetState({ position, heading } = {}) {
      if (position) {
        this.setWorldPosition(position.x, position.y);
      }
      if (typeof heading === "number") {
        this.heading = heading;
      }
      setVector(this.velocity, 0, 0);
      this.angularVelocity = 0;
      this.engineRpm = this.idleRpm;
      this.throttle = 0;
      this.brake = 0;
      this.reverseMode = false;
    }

    getWorldPosition() {
      return {
        x: this.position.x * this.pixelsPerMeter,
        y: this.position.y * this.pixelsPerMeter
      };
    }

    getSpeedMetersPerSecond() {
      return length(this.velocity);
    }

    getSpeedPixelsPerSecond() {
      return this.getSpeedMetersPerSecond() * this.pixelsPerMeter;
    }

    getLongitudinalSpeed() {
      const forward = this.forwardVector();
      return dot(this.velocity, forward);
    }

    dampVelocity(factor) {
      scaleInPlace(this.velocity, factor);
      this.angularVelocity *= factor;
    }

    stop() {
      setVector(this.velocity, 0, 0);
      this.angularVelocity = 0;
    }

    setManualMode(enabled) {
      this.manualMode = !!enabled;
      if (!this.manualMode) {
        if (this.gearIndex <= 0) {
          this.gearIndex = Math.min(1, this.config.gearRatios.length - 1);
        }
        this.reverseMode = false;
      } else {
        this.reverseMode = this.gearIndex === -1;
      }
    }

    isManualMode() {
      return this.manualMode;
    }

    shiftUp() {
      if (!this.manualMode) {
        return false;
      }
      const maxGear = this.config.gearRatios.length - 1;
      const nextGear = Math.min(maxGear, this.gearIndex + 1);
      if (nextGear !== this.gearIndex) {
        this.gearIndex = nextGear;
        if (this.manualMode) {
          this.reverseMode = this.gearIndex === -1;
        }
        return true;
      }
      return false;
    }

    shiftDown() {
      if (!this.manualMode) {
        return false;
      }
      const nextGear = Math.max(-1, this.gearIndex - 1);
      if (nextGear !== this.gearIndex) {
        this.gearIndex = nextGear;
        if (this.manualMode) {
          this.reverseMode = this.gearIndex === -1;
        }
        return true;
      }
      return false;
    }

    computeAeroForces(speed, backwards = false) {
      const drag =
        0.5 *
        AIR_DENSITY *
        this.config.dragCoefficient *
        (backwards ? 2 : 1) *
        this.config.frontalAreaM2 *
        speed *
        speed;
      const downforceScale = clamp((speed * 2.237) / 40, 0, 1);
      const downforce =
        0.5 *
        AIR_DENSITY *
        this.config.downforceCoefficient *
        this.config.frontalAreaM2 *
        speed *
        speed *
        downforceScale;
      return { drag, downforce };
    }

    updatePowertrain(throttleInput, vLong, dt) {
      const throttleRate = 4;
      const target = clamp(throttleInput, -1, 1);
      this.throttle += (target - this.throttle) * clamp(dt * throttleRate, 0, 1);
      this.throttle = clamp(this.throttle, -1, 1);

      const speedAbs = Math.abs(vLong);
      if (this.manualMode) {
        this.reverseMode = this.gearIndex === -1;
      } else {
        if (this.reverseMode) {
          if (this.throttle > 0.1 && speedAbs < 0.6) {
            this.reverseMode = false;
            this.throttle = clamp(this.throttle, 0, 1);
          }
        } else if (this.throttle < -0.1 && speedAbs < 0.6) {
          this.reverseMode = true;
          if (this.gearIndex < 1) {
            this.gearIndex = 1;
          }
        }
      }

      const forwardGearIndex = Math.max(0, this.gearIndex);
      const effectiveGearRatio = this.reverseMode
        ? this.reverseGearRatio
        : this.config.gearRatios[forwardGearIndex];

      const wheelRadius = this.config.wheelRadiusM;
      const finalDrive = this.config.finalDriveRatio;

      if (effectiveGearRatio > 0 && speedAbs > 0.1) {
        const wheelAngularSpeed = speedAbs / wheelRadius;
        this.engineRpm = Math.max(
          this.idleRpm,
          Math.abs(wheelAngularSpeed * effectiveGearRatio * finalDrive * 60 / (2 * Math.PI))
        );
      } else {
        this.engineRpm = Math.max(this.engineRpm * 0.98, this.idleRpm);
      }

      this.revLimiterActive = false;
      if (this.engineRpm > this.revLimiterRpm) {
        this.revLimiterActive = true;
        this.engineRpm = this.revLimiterRpm;
          // Apply rev-limiter reduction to throttle magnitude regardless of direction
          // so reverse throttle is also constrained when engine RPM exceeds the limiter.
          if (Math.abs(this.throttle) > 0.7) {
            const signThrottle = this.throttle >= 0 ? 1 : -1;
            this.throttle = signThrottle * Math.abs(this.throttle) * 0.6;
          }
      }

      if (!this.manualMode && !this.reverseMode) {
        if (
          this.engineRpm > this.upshiftRpm &&
          this.gearIndex < this.config.gearRatios.length - 1
        ) {
          this.gearIndex += 1;
        } else if (
          this.engineRpm < this.downshiftRpm &&
          this.gearIndex > 1 &&
          this.throttle < 0.8
        ) {
          this.gearIndex -= 1;
        }
      }
    }

    computeLongitudinalForces(brakeInput, dt, vLong) {
      const brakeRate = 6;
      this.brake += (brakeInput - this.brake) * clamp(dt * brakeRate, 0, 1);
      this.brake = clamp(this.brake, 0, 1);

      let gearRatio;
      if (this.reverseMode) {
        gearRatio = this.reverseGearRatio;
      } else {
        const forwardGearIndex = Math.max(0, this.gearIndex);
        gearRatio = this.config.gearRatios[forwardGearIndex];
      }

      let driveForce = 0;
      if (gearRatio > 0) {
        const throttleMagnitude = this.reverseMode
          ? Math.abs(this.throttle)
          : Math.max(this.throttle, 0);
        const torque =
          this.torqueAtRpm(this.engineRpm) *
          throttleMagnitude *
          this.config.drivetrainEfficiency;
        if (torque > 0) {
          const baseForce =
            (torque * gearRatio * this.config.finalDriveRatio) /
            (this.config.wheelRadiusM + 1e-6);
          driveForce = this.reverseMode ? -baseForce : baseForce;
        }
      }

      // Reduce drive force magnitude when rev limiter is active regardless of sign
      // to prevent unchecked torque in reverse.
      if (this.revLimiterActive && Math.abs(driveForce) > 0) {
        driveForce *= 0.15;
      }

      const wheelRadius = this.config.wheelRadiusM + 1e-6;
      const brakeFraction = this.brake;
      const brakeForces = this.brakeTorquePerWheelNm.map((torque) => (torque * brakeFraction) / wheelRadius);
      return { driveForce, brakeForces };
    }

    torqueAtRpm(rpm) {
      const cfg = this.config;
      const limiterRpm = this.revLimiterRpm;
      const idle = this.idleRpm;
      const peak = this.peakRpm;
      let effectiveRpm = clamp(rpm, idle, limiterRpm + 600);

      if (effectiveRpm <= peak) {
        const ratio = clamp((effectiveRpm - idle) / Math.max(1, peak - idle), 0, 1);
        const shaped = Math.pow(ratio, 1.25);
        const torqueFactor = 0.65 + 0.35 * shaped;
        return cfg.peakTorqueNm * clamp(torqueFactor, 0.45, 1.05);
      }

      if (effectiveRpm <= limiterRpm) {
        const torqueFromHp = (cfg.horsepower * 5252) / Math.max(effectiveRpm, 1);
        const minTorque = cfg.peakTorqueNm * 0.45;
        return clamp(torqueFromHp, minTorque, cfg.peakTorqueNm);
      }

      const overshoot = clamp((effectiveRpm - limiterRpm) / 600, 0, 1);
      return cfg.peakTorqueNm * clamp(0.12 * (1 - overshoot), 0.05, 0.12);
    }

    _estimateTurnRadius(absSteer, vLong, vLat) {
      if (absSteer > 0.001) {
        return Math.max(this.config.trackWidthM, Math.abs(this.config.wheelbaseM / Math.tan(absSteer)));
      }
      const yawRate = Math.abs(this.angularVelocity);
      if (yawRate > 0.05 && Math.abs(vLong) > 0.2) {
        return Math.max(this.config.trackWidthM, Math.abs(vLong) / Math.max(yawRate, 1e-3));
      }
      if (Math.abs(vLat) > 0.5 && Math.abs(vLong) > 0.1) {
        return Math.max(this.config.trackWidthM, Math.abs(vLong) / Math.max(Math.abs(vLat), 1e-3));
      }
      return Infinity;
    }

    _computeDifferentialScales(vLong, vLat, speed) {
      const result = {
        front: { left: 1, right: 1 },
        rear: { left: 1, right: 1 }
      };
      const steer = this.steerAngle;
      const signSource =
        Math.abs(steer) > 0.002
          ? steer
          : Math.abs(this.angularVelocity) > 0.05
            ? this.angularVelocity
            : Math.abs(vLat) > 0.25
              ? vLat
              : 0;
      const turnSign = Math.sign(signSource);
      if (!turnSign || speed < 0.5) {
        return result;
      }
      const radius = this._estimateTurnRadius(Math.abs(steer), vLong, vLat);
      if (!Number.isFinite(radius) || radius > 1e5) {
        return result;
      }
      const halfTrack = Math.max(0.25, this.config.trackWidthM * 0.5);
      const differentialStrength = 0.9;
      const ratioBase = clamp((halfTrack / Math.max(radius, halfTrack)) * differentialStrength, 0, 0.35);
      if (ratioBase <= 0.0001) {
        return result;
      }
      const insideScale = 1 - ratioBase;
      const outsideScale = 1 + ratioBase;
      if (turnSign > 0) {
        // Positive steer turns right: right wheels are on the inside of the corner.
        result.front.right = insideScale;
        result.rear.right = insideScale;
        result.front.left = outsideScale;
        result.rear.left = outsideScale;
      } else {
        result.front.left = insideScale;
        result.rear.left = insideScale;
        result.front.right = outsideScale;
        result.rear.right = outsideScale;
      }
      return result;
    }

    update(throttleInput, brakeInput, steerInput, dt) {
      const forward = this.forwardVector();
      const right = this.rightVector();

      const vLong = dot(this.velocity, forward);
      const vLat = dot(this.velocity, right);
      const speed = length(this.velocity);

      this.updatePowertrain(throttleInput, vLong, dt);

      const baseMaxSteer = Math.PI / 4; // about 45 degrees of lock
      const targetSteer = clamp(steerInput, -1, 1) * baseMaxSteer;
      this.steerAngle = targetSteer;

      const backwardsMotion = vLong < -0.2;
      const { drag: dragForce, downforce } = this.computeAeroForces(speed, backwardsMotion);
      const { driveForce, brakeForces } = this.computeLongitudinalForces(brakeInput, dt, vLong);

      const weight = this.config.massKg * G;
      const frontStatic = weight * this.config.frontWeightDistribution;
      const rearStatic = weight - frontStatic;
      const downforceFront = downforce * this.config.frontWeightDistribution;
      const downforceRear = downforce - downforceFront;

      const longitudinalTransfer =
        (this.config.massKg *
          this.lastLongitudinalAccel *
          this.config.cgHeightM) /
        Math.max(0.1, this.config.wheelbaseM);
      const frontAxleLoad = frontStatic + downforceFront - longitudinalTransfer;
      const rearAxleLoad = rearStatic + downforceRear + longitudinalTransfer;

      const lateralBias = clamp(
        (this.lastLateralAccel * this.config.cgHeightM) /
          (G * Math.max(0.1, this.config.trackWidthM)),
        -0.45,
        0.45
      );

      const tireNormals = [
        Math.max(0, frontAxleLoad * 0.5 * (1 + lateralBias)),
        Math.max(0, frontAxleLoad * 0.5 * (1 - lateralBias)),
        Math.max(0, rearAxleLoad * 0.5 * (1 + lateralBias)),
        Math.max(0, rearAxleLoad * 0.5 * (1 - lateralBias))
      ];

      let frontAlignment = 0;
      if (speed > 0.5) {
        const invSpeed = 1 / speed;
        const momentumDir = {
          x: this.velocity.x * invSpeed,
          y: this.velocity.y * invSpeed
        };
        const frontDir = {
          x: Math.cos(this.heading + this.steerAngle),
          y: Math.sin(this.heading + this.steerAngle)
        };
        frontAlignment = clamp(dot(frontDir, momentumDir), 0, 1);
      }
      const brakingForward = this.brake > 0.05 && vLong > 0.2;
      const frontGripBonus =
        frontAlignment * 0.8 + (brakingForward ? this.brake * 0.55 : 0.1);

      let slipAngleFront = 0;
      let slipAngleRear = 0;
      if (Math.abs(vLong) > 0.5) {
        slipAngleFront =
          Math.atan2(vLat + this.angularVelocity * this.lf, Math.abs(vLong)) -
          this.steerAngle * sign(vLong);
        slipAngleRear = Math.atan2(vLat - this.angularVelocity * this.lr, Math.abs(vLong));
      } else if (speed > 0.5) {
        slipAngleFront =
          Math.atan2(vLat + this.angularVelocity * this.lf, 0.5) - this.steerAngle;
        slipAngleRear = Math.atan2(vLat - this.angularVelocity * this.lr, 0.5);
      }

      const corneringStiffnessFront = 80000;
      const corneringStiffnessRear = 90000;
      let frontTotalLat = -corneringStiffnessFront * slipAngleFront;
      let rearTotalLat = -corneringStiffnessRear * slipAngleRear;

      const maxFrontLat =
        this.lateralGripCoeffs[0] * tireNormals[0] +
        this.lateralGripCoeffs[1] * tireNormals[1];
      const maxRearLat =
        this.lateralGripCoeffs[2] * tireNormals[2] +
        this.lateralGripCoeffs[3] * tireNormals[3];

      frontTotalLat = clamp(frontTotalLat, -maxFrontLat, maxFrontLat);
      rearTotalLat = clamp(rearTotalLat, -maxRearLat, maxRearLat);

      const driveFront = driveForce * this.driveSplitFront;
      const driveRear = driveForce * this.driveSplitRear;
      const driveFrontPerWheel = driveFront * 0.5;
      const driveRearPerWheel = driveRear * 0.5;
      const differentialScales = this._computeDifferentialScales(vLong, vLat, speed);
      const frontLeftDrive = driveFrontPerWheel * differentialScales.front.left;
      const frontRightDrive = driveFrontPerWheel * differentialScales.front.right;
      const rearLeftDrive = driveRearPerWheel * differentialScales.rear.left;
      const rearRightDrive = driveRearPerWheel * differentialScales.rear.right;
      const brakeForcesArray = Array.isArray(brakeForces) && brakeForces.length >= 4
        ? brakeForces
        : [0, 0, 0, 0];
      let brakeDirection = Math.sign(vLong);
      // If longitudinal speed is nearly zero, default brake direction to forward
      // (previous code referenced `this.velocity.forward` which does not exist and
      // could produce NaN). This avoids propagating NaN into tire force calculations
      // which could lead to runaway values.
      if (Math.abs(brakeDirection) < 0.1) {
        brakeDirection = 1;
      }
      const tireForcesLong = [
        frontLeftDrive - brakeDirection * brakeForcesArray[0],
        frontRightDrive - brakeDirection * brakeForcesArray[1],
        rearLeftDrive - brakeDirection * brakeForcesArray[2],
        rearRightDrive - brakeDirection * brakeForcesArray[3]
      ];

      const frontLatLeft = frontTotalLat * 0.5 * (1 + lateralBias);
      const frontLatRight = frontTotalLat * 0.5 * (1 - lateralBias);
      const rearLatLeft = rearTotalLat * 0.5 * (1 + lateralBias);
      const rearLatRight = rearTotalLat * 0.5 * (1 - lateralBias);

      const tireForcesLat = [frontLatLeft, frontLatRight, rearLatLeft, rearLatRight];

      let totalLongitudinal = 0;
      let totalLateral = 0;
      let totalYawMoment = 0;

      const wheelPositions = [
        { x: this.lf, y: this.config.trackWidthM * 0.5 },
        { x: this.lf, y: -this.config.trackWidthM * 0.5 },
        { x: -this.lr, y: this.config.trackWidthM * 0.5 },
        { x: -this.lr, y: -this.config.trackWidthM * 0.5 }
      ];

      for (let i = 0; i < this.tires.length; i += 1) {
        const tire = this.tires[i];
        const normal = tireNormals[i];
        let fLong = tireForcesLong[i];
        let fLat = tireForcesLat[i];
        const longitudinalCapBase = Math.max(0, this.longitudinalGripCoeffs[i] * normal);
        const lateralCapBase = Math.max(0, this.lateralGripCoeffs[i] * normal);
        const latMultiplier = i < 2 ? 1 + Math.max(0, frontGripBonus) : 1;
        const longitudinalCap = longitudinalCapBase;
        const lateralCap = lateralCapBase * latMultiplier;
        const longRatio =
          longitudinalCap > 1e-6 ? (fLong / (longitudinalCap + 1e-6)) ** 2 : 0;
        const latRatio =
          lateralCap > 1e-6 ? (fLat / (lateralCap + 1e-6)) ** 2 : 0;
        const loadRatio = Math.sqrt(longRatio + latRatio);
        if (loadRatio > 1 && (longitudinalCap > 0 || lateralCap > 0)) {
          const scale = 1 / loadRatio;
          fLong *= scale;
          fLat *= scale;
          tire.hasTraction = false;
        } else {
          tire.hasTraction = true;
        }
        tire.normalLoad = normal;
        setVector(tire.combinedForce, fLong, fLat);

        totalLongitudinal += fLong;
        totalLateral += fLat;
        const wp = wheelPositions[i];
        totalYawMoment += wp.x * fLat - wp.y * fLong;
      }

      let forceWorld = {
        x: forward.x * totalLongitudinal + right.x * totalLateral,
        y: forward.y * totalLongitudinal + right.y * totalLateral
      };

      if (speed > 1e-3) {
        const velDir = normalize(this.velocity);
        const dragVec = { x: -velDir.x * dragForce, y: -velDir.y * dragForce };
        const rollingVec = {
          x: -velDir.x * (this.config.rollingResistanceCoeff * weight),
          y: -velDir.y * (this.config.rollingResistanceCoeff * weight)
        };
        forceWorld = {
          x: forceWorld.x + dragVec.x + rollingVec.x,
          y: forceWorld.y + dragVec.y + rollingVec.y
        };
      }

      const acceleration = {
        x: forceWorld.x / this.config.massKg,
        y: forceWorld.y / this.config.massKg
      };

      addScaledInPlace(this.velocity, acceleration, dt);
      addScaledInPlace(this.position, this.velocity, dt);

      const angularAccel = totalYawMoment / (this.inertia + 1e-6);
      this.angularVelocity += angularAccel * dt;
      this.heading += this.angularVelocity * dt;
      this.heading = ((this.heading + Math.PI) % (2 * Math.PI)) - Math.PI;

      this.lastLongitudinalAccel = dot(acceleration, forward);
      this.lastLateralAccel = dot(acceleration, right);

      if (speed < 0.2 && Math.abs(this.throttle) < 0.05 && this.brake > 0.1) {
        scaleInPlace(this.velocity, 0.5);
        if (length(this.velocity) < 0.05) {
          setVector(this.velocity, 0, 0);
          this.angularVelocity = 0;
        }
      }
    }

    worldPoints() {
      const lengthM = this.config.wheelbaseM + 1.2;
      const widthM = this.config.trackWidthM + 0.6;
      const halfLength = lengthM * 0.5;
      const halfWidth = widthM * 0.5;
      const corners = [
        { x: halfLength, y: halfWidth },
        { x: halfLength, y: -halfWidth },
        { x: -halfLength, y: -halfWidth },
        { x: -halfLength, y: halfWidth }
      ];
      const forward = this.forwardVector();
      const right = this.rightVector();
      return corners.map((corner) => {
        const cornerMeters = {
          x: this.position.x + forward.x * corner.x + right.x * corner.y,
          y: this.position.y + forward.y * corner.x + right.y * corner.y
        };
        return {
          x: cornerMeters.x * this.pixelsPerMeter,
          y: cornerMeters.y * this.pixelsPerMeter
        };
      });
    }

    serializeState() {
      return {
        position: this.getWorldPosition(),
        heading: this.heading,
        velocity: { x: this.velocity.x, y: this.velocity.y },
        angularVelocity: this.angularVelocity,
        steerAngle: this.steerAngle,
        engineRpm: this.engineRpm,
        throttle: this.throttle,
        brake: this.brake,
        gearIndex: this.gearIndex,
        reverseMode: this.reverseMode,
        manualMode: this.manualMode,
        lastLongitudinalAccel: this.lastLongitudinalAccel,
        lastLateralAccel: this.lastLateralAccel
      };
    }

    restoreState(state = {}) {
      if (!state || typeof state !== "object") {
        return;
      }

      const pos = state.position;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        this.setWorldPosition(pos.x, pos.y);
      }
      if (Number.isFinite(state.heading)) {
        this.heading = state.heading;
      }
      if (state.velocity) {
        const { x, y } = state.velocity;
        this.velocity.x = Number.isFinite(x) ? x : 0;
        this.velocity.y = Number.isFinite(y) ? y : 0;
      }
      if (Number.isFinite(state.angularVelocity)) {
        this.angularVelocity = state.angularVelocity;
      }
      if (Number.isFinite(state.steerAngle)) {
        this.steerAngle = state.steerAngle;
      }
      if (Number.isFinite(state.engineRpm)) {
        this.engineRpm = clamp(state.engineRpm, this.idleRpm, this.revLimiterRpm * 1.05);
      } else {
        this.engineRpm = this.idleRpm;
      }
      if (Number.isFinite(state.throttle)) {
        this.throttle = clamp(state.throttle, -1, 1);
      } else {
        this.throttle = 0;
      }
      if (Number.isFinite(state.brake)) {
        this.brake = clamp(state.brake, 0, 1);
      } else {
        this.brake = 0;
      }
      if (Number.isFinite(state.gearIndex)) {
        this.gearIndex = Math.trunc(state.gearIndex);
      }
      this.reverseMode = state.reverseMode === true;
      this.manualMode = state.manualMode === true;
      if (Number.isFinite(state.lastLongitudinalAccel)) {
        this.lastLongitudinalAccel = state.lastLongitudinalAccel;
      }
      if (Number.isFinite(state.lastLateralAccel)) {
        this.lastLateralAccel = state.lastLateralAccel;
      }
    }
  }

  globalThis.RockportPhysics = {
    G,
    AIR_DENSITY,
    Car,
    Tire,
    defaultCarConfig,
    clamp
  };
})();

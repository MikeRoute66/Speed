# Rockport Vehicle Data Playbook

This document captures a repeatable process for expanding the Rockport car catalogue from the current seed list to 1,000+ real-world vehicles.

## 1. Required data points

Each entry in `carSpecs.js` should provide (directly or via approximation):

| Field | Description | Notes / Typical Source |
| --- | --- | --- |
| `massKg` | Curb mass in kilograms | Manufacturer spec sheets, Wikipedia |
| `driveType` | `"FWD"`, `"RWD"`, or `"AWD"` | Manufacturer specs |
| `horsepower` | Peak engine output (SAE hp) | Manufacturer, dyno databases |
| `torqueNm` | Peak engine torque (Nm) | Manufacturer |
| `gearRatios` | Array including `0.0` for neutral followed by gear ratios | Workshop manuals, enthusiast forums, Forza data dumps |
| `finalDrive` | Final drive ratio | Same sources as gear ratios |
| `dragCoefficient` | Aerodynamic Cd | Wikipedia, test reports |
| `downforceCoefficient` | Effective downforce coefficient at speed | Simulation titles (Forza/Gran Turismo), aero studies; estimate if unknown |
| `frontalAreaM2` | Reference area | Manufacturer data, wind tunnel reports, or area = width × height × 0.85 |
| `wheelRadiusM` | Rolling radius ≈ tyre diameter / 2 | Tyre size calculators |
| `tireGrips` | 4-value array (FL, FR, RL, RR) | Tyre compound + weight bias; extrapolate from performance peers |
| `wheelbaseM`, `cgHeightM`, `trackWidthM`, `frontWeightDistribution` | Chassis geometry & weight distribution | Technical documents, forums |
| `drivetrainEfficiency`, `rollingResistanceCoeff` | Loss/drag factors | Defaults: 0.90–0.93 and 0.015–0.017; adjust per drivetrain |
| `brakeTorquePerWheelNm`, `brakeBiasFront` | Maximum brake torque per wheel and front bias | Manufacturer brake specs, aftermarket catalogues; if unknown, scale from rotor size/caliper data |

If `brakeHorsepower` is omitted, the loader will compute one automatically as ~82% of engine horsepower.

## 2. Primary reference sources

1. **Manufacturer press kits & technical guides**  
   Usually contain official power, torque, mass, aero Cd, and tyre sizes.

2. **Wikipedia + Wikidata**  
   Merges disparate sources; especially useful for quick specs (mass, Cd, drivetrain). Always cross-check with primary sources.

3. **Forza/Gran Turismo/Assetto Corsa community exports**  
   These titles provide gear ratios, final drive, weight distribution, tyre compound hints, and sometimes frontal area.  
   - Forza Motorsport 7 & Horizon: CSV exports exist on the Forza forums.  
   - Assetto Corsa Competizione: `car.ini` files include detailed physics parameters.  

4. **Top Drives & enthusiast forums**  
   Discussions often list gearbox ratios, tyre compounds, and estimated grip values derived from comparable vehicles.

5. **Automotive media tests (Car and Driver, Evo, AutoBild, MotorTrend)**  
   Provide corroborating data for weight, drag, downforce add-ons, and sometimes CG height estimates.

## 3. Scaling workflow (1000+ cars)

1. **Curate a master list**  
   - Start from reputable lists (e.g., Forza Horizon car lists, GT Sport roster, Wikipedia's "List of production sports cars").  
   - Store minimum metadata: manufacturer, model, year, drivetrain.

2. **Batch ingestion script (future work)**  
   - Build a Node or Python script that reads a CSV/JSON of candidates.  
   - For each car, attempt to pre-fill fields from known datasets (Forza exports, Wikidata API).  
   - Flag missing values for manual follow-up.

3. **Manual/assisted validation**  
   - Use a shared spreadsheet filtered by "missing field" columns.  
   - Leverage crowdsourced references (Top Drives forums, owner manuals) to fill gaps.  
   - Record source URLs for traceability (store in the `sources` array).

4. **Approximation guidelines**  
   - **Missing drag coefficient:** use class averages (e.g., modern sports coupe ≈ 0.30–0.33, hot hatch ≈ 0.31–0.34).  
   - **Downforce coefficient:** stock road cars 0.9–1.2; track variants 1.3–1.7; race cars 2.0+.  
- **Tyre grip:** start from compound (Eco 0.95, Max performance 1.05, R-compound 1.15). Bias left/right using weight distribution.  
- **CG height:** sedans/hatches 0.52–0.58 m; sports cars 0.47–0.52 m; SUVs 0.60+.  
- Document approximations with a `notes` field referencing the baseline vehicle used.

### Tyre compound quick reference

| Tyre class | Example OE tyres | Suggested longitudinal grip | Suggested lateral grip |
| --- | --- | --- | --- |
| Ultra high performance | Michelin Pilot Sport 4S, Continental SportContact 6 | 1.02–1.08 | 1.10–1.18 |
| Track-focused (semi-slick) | Michelin Pilot Sport Cup 2, Pirelli Trofeo R | 1.15–1.22 | 1.30–1.38 |
| Performance all-season | Pirelli P Zero All Season | 0.98–1.02 | 1.02–1.08 |
| R-compound / race slick | Yokohama A052, Hankook Ventus TD | 1.25–1.32 | 1.40+ |

When adding entries, populate both `tireGrips` (longitudinal) and `tireGripLat` (lateral) arrays; the ingestion script recognises `tireGripLat`, `tireGripLateral`, or `tireGripSide` columns.


5. **Quality checks**  
   - Run automated validators to ensure arrays (gear ratios, tyre grips) have expected lengths.  
   - Simulate each car in a batch smoke test to confirm no NaN or unrealistic behaviour (0–100 km/h within expected bounds).

## 4. Current seed coverage

The initial `RockportCarCatalog` covers 10 performance-oriented vehicles across varied drivetrain layouts (FWD, RWD, AWD) and regions. Each entry includes a `sources` array citing the primary references. This seed list serves as a template when expanding to additional manufacturers and vehicle classes.

## 5. Next steps

- Automate catalog expansion via scripted ingestion (see §3).  
- Build a validation dashboard that highlights missing or estimated values.  
- Establish a contribution template (PR checklist) requiring: primary source link, chosen approximation method, and change summary.

## 6. Tooling: `tools/ingestCars.js`

Use the ingestion script to merge new cars into `Rockport/carSpecs.js` without manual editing.

```
node tools/ingestCars.js --input data/new-cars.json
node tools/ingestCars.js --input data/sports.csv --output Rockport/carSpecs.js
```

- Accepts JSON arrays (preferred) or CSV files with the flattened column set described in §1.  
- Automatically normalises units, fills in derived values (e.g., prepend `0.0` to gear ratios, compute brake horsepower), and merges on the `id` field.  
- Ensures the catalog remains sorted alphabetically by the car label and keeps source citations intact.

By following this playbook, we can systematically scale the database with transparent, defensible data for each car.

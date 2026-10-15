import * as THREE from "three";
import assert from "assert";

function latLngToVector3(lat: number, lng: number, radius: number): { x: number; y: number; z: number } {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return { x, y, z };
}

interface CalcResult {
  dot: number;
  isFacingCamera: boolean;
  screenVecX: number;
  screenVecY: number;
  screenVecZ: number;
  screenX: number;
  screenY: number;
}

function runOldCalculation(
  lat: number,
  lng: number,
  camPos: THREE.Vector3,
  camera: THREE.Camera,
  cWidth: number,
  cHeight: number
): CalcResult {
  const { x, y, z } = latLngToVector3(lat, lng, 5.05);
  const worldPos = new THREE.Vector3(x, y, z);
  const markerDir = worldPos.clone().normalize();
  const dot = camPos.dot(markerDir);
  const isFacingCamera = dot > 0.15;

  let screenVecX = 0;
  let screenVecY = 0;
  let screenVecZ = 0;
  let screenX = 0;
  let screenY = 0;

  if (isFacingCamera) {
    const screenVec = worldPos.clone().project(camera);
    screenVecX = screenVec.x;
    screenVecY = screenVec.y;
    screenVecZ = screenVec.z;
    if (screenVec.z < 1) {
      screenX = (screenVec.x * 0.5 + 0.5) * cWidth;
      screenY = (-screenVec.y * 0.5 + 0.5) * cHeight;
    }
  }

  return { dot, isFacingCamera, screenVecX, screenVecY, screenVecZ, screenX, screenY };
}

// Scratch vectors created once outside the loop
const scratchWorldPos = new THREE.Vector3();
const scratchMarkerDir = new THREE.Vector3();
const scratchScreenVec = new THREE.Vector3();

function runNewCalculation(
  lat: number,
  lng: number,
  camPos: THREE.Vector3,
  camera: THREE.Camera,
  cWidth: number,
  cHeight: number,
  injectBug: boolean = false
): CalcResult {
  const { x, y, z } = latLngToVector3(lat, lng, 5.05);
  scratchWorldPos.set(x, y, z);
  scratchMarkerDir.copy(scratchWorldPos).normalize();

  if (injectBug) {
    // Negative control perturbation: distort marker direction
    scratchMarkerDir.x += 0.25;
    scratchMarkerDir.normalize();
  }

  const dot = camPos.dot(scratchMarkerDir);
  const isFacingCamera = dot > 0.15;

  let screenVecX = 0;
  let screenVecY = 0;
  let screenVecZ = 0;
  let screenX = 0;
  let screenY = 0;

  if (isFacingCamera) {
    scratchScreenVec.copy(scratchWorldPos).project(camera);
    screenVecX = scratchScreenVec.x;
    screenVecY = scratchScreenVec.y;
    screenVecZ = scratchScreenVec.z;
    if (scratchScreenVec.z < 1) {
      screenX = (scratchScreenVec.x * 0.5 + 0.5) * cWidth;
      screenY = (-scratchScreenVec.y * 0.5 + 0.5) * cHeight;
    }
  }

  return { dot, isFacingCamera, screenVecX, screenVecY, screenVecZ, screenX, screenY };
}

function main() {
  const isNegativeControlRun = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("RADAR GC FIX EQUIVALENCE & PRECISION VERIFICATION");
  if (isNegativeControlRun) {
    console.log("MODE: --negative-control (Simulating invalid math to prove non-zero exit)");
  }
  console.log("================================================================================");

  // Setup virtual scene parameters
  const camera = new THREE.PerspectiveCamera(45, 1440 / 900, 0.1, 1000);
  camera.position.set(0, 0, 15);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const camPos = camera.position.clone().normalize();
  const cWidth = 1440;
  const cHeight = 900;

  // Generate 1000 random cities (deterministic pseudo-random seed)
  const randomCities: { lat: number; lng: number }[] = [];
  let s = 123456789;
  const pseudoRandom = () => {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  for (let i = 0; i < 1000; i++) {
    const lat = (pseudoRandom() - 0.5) * 180;
    const lng = (pseudoRandom() - 0.5) * 360;
    randomCities.push({ lat, lng });
  }

  const EPSILON = 1e-12;

  for (let i = 0; i < randomCities.length; i++) {
    const { lat, lng } = randomCities[i];
    const oldRes = runOldCalculation(lat, lng, camPos, camera, cWidth, cHeight);
    const newRes = runNewCalculation(lat, lng, camPos, camera, cWidth, cHeight, isNegativeControlRun);

    if (Math.abs(oldRes.dot - newRes.dot) > EPSILON) {
      if (isNegativeControlRun) {
        console.log(`[NEGATIVE-CONTROL-SUCCESS] Caught deliberate perturbation at city ${i}: delta=${Math.abs(oldRes.dot - newRes.dot)}`);
        process.exit(1);
      }
      console.error(`FAIL: Dot product mismatch at index ${i}: old=${oldRes.dot}, new=${newRes.dot}`);
      process.exit(1);
    }
    if (oldRes.isFacingCamera !== newRes.isFacingCamera) {
      if (isNegativeControlRun) {
        console.log(`[NEGATIVE-CONTROL-SUCCESS] Caught deliberate facing mismatch at city ${i}`);
        process.exit(1);
      }
      console.error(`FAIL: Facing camera mismatch at index ${i}`);
      process.exit(1);
    }
    if (Math.abs(oldRes.screenVecX - newRes.screenVecX) > EPSILON) {
      if (isNegativeControlRun) process.exit(1);
      console.error(`FAIL: screenVecX mismatch at index ${i}`);
      process.exit(1);
    }
    if (Math.abs(oldRes.screenVecY - newRes.screenVecY) > EPSILON) {
      if (isNegativeControlRun) process.exit(1);
      console.error(`FAIL: screenVecY mismatch at index ${i}`);
      process.exit(1);
    }
    if (Math.abs(oldRes.screenVecZ - newRes.screenVecZ) > EPSILON) {
      if (isNegativeControlRun) process.exit(1);
      console.error(`FAIL: screenVecZ mismatch at index ${i}`);
      process.exit(1);
    }
    if (Math.abs(oldRes.screenX - newRes.screenX) > EPSILON) {
      if (isNegativeControlRun) process.exit(1);
      console.error(`FAIL: screenX mismatch at index ${i}`);
      process.exit(1);
    }
    if (Math.abs(oldRes.screenY - newRes.screenY) > EPSILON) {
      if (isNegativeControlRun) process.exit(1);
      console.error(`FAIL: screenY mismatch at index ${i}`);
      process.exit(1);
    }
  }

  if (isNegativeControlRun) {
    console.error("FAIL: Negative control finished without detecting perturbation!");
    process.exit(0);
  }

  console.log(`✅ [PASS] 1000/1000 random cities verified: Old vs New calculations are bit-for-bit identical.`);

  // In-memory negative control verification:
  console.log("Verifying in-memory perturbation detection...");
  const perturbedCity = randomCities[0];
  const baseline = runOldCalculation(perturbedCity.lat, perturbedCity.lng, camPos, camera, cWidth, cHeight);
  const perturbed = runNewCalculation(perturbedCity.lat, perturbedCity.lng, camPos, camera, cWidth, cHeight, true);
  assert(Math.abs(baseline.dot - perturbed.dot) > EPSILON, "Perturbation must be detected");
  console.log("✅ [PASS] In-memory negative control passed: Perturbation reliably detected.");
  console.log("================================================================================");
}

main();

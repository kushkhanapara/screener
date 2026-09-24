import snapback from "../vwapSnapback.js";
import vwapVolumeProfile, { vwapVolumeProfile as build } from "./strategy.js";

/**
 * What `npm run replay -- --vwapvp` runs: the strategy with both setups, each
 * setup on its own, and VWAP Snap-back — the existing flat-day strategy it
 * overlaps with — as the yardstick.
 */
export const VWAP_VP_BOOKS = [
  vwapVolumeProfile,
  build({ id: "vwap-vp-trend", name: "VWAP + VP · trend only", modes: ["trend"] }),
  build({ id: "vwap-vp-rotation", name: "VWAP + VP · rotation only", modes: ["rotation"] }),
  snapback,
];

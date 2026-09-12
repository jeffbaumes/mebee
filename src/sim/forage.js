// Pollen and nectar foraging.
//
// Every flower head holds its own supply of both, which crawling on it drains
// into the bee's own two capacities. A flower's remaining supply lives here,
// indexed by plant, so leaving one and coming back finds it exactly as it was
// left -- nothing about a flower's supply is ever read from the GPU or reset
// by a re-render.
//
// Each flower's own MAXIMUM is drawn from its species' mean and spread (see
// the `forage` field on every entry in geom/species.js) -- a mayweed is a
// pollen crop, a cornflower a nectar one, and two mayweeds still differ from
// each other the way two real flowers do. A freshly-generated flower starts
// only partway down that maximum, not brim full: a meadow a bee wanders into
// already has flowers at every stage of being visited, not a field reset to
// "full" the moment the game begins.
//
// Offloading the bee's cargo is not modelled yet: once a capacity is full,
// collect() simply stops adding to it. The flower still empties underneath a
// full bee, same as it would for one with room left.

import { makeRng } from '../geom/rand.js';

// However far a gaussian draw wanders, a flower can never end up with
// (effectively) nothing to offer or a negative capacity.
const MIN_SUPPLY = 0.05;
// A never-visited flower starts with at least this fraction of its own max,
// and at most all of it -- see the constructor.
const MIN_FILL_FRACTION = 0.15;

// A hundred flowers' worth of an average species' supply, per the original
// brief -- still the right order of magnitude even though flowers now vary
// and are rarely drained all the way (see COLLECT_RATE).
export const BEE_CAPACITY = 100;

/**
 * Fraction of a flower's REMAINING supply collected per second of crawling.
 *
 * Exponential rather than a fixed per-flower duration: the first second on a
 * fresh flower earns far more than the fifth, because each second only takes
 * a cut of whatever is still left. That is what makes leaving a flower a real
 * decision -- camping it longer always adds a little more, but with steadily
 * worse and worse return on the time spent.
 */
const COLLECT_RATE = 0.9; // 1/s

export class Forage {
  /**
   * @param {{species:number}[]} plants   one entry per plant; `species` is an
   *   index into `speciesList`, in the same order field.js assigned them
   * @param {object[]} speciesList        SPECIES, carrying each entry's own
   *   `forage` field -- see geom/species.js
   */
  constructor(plants, speciesList, seed = 91) {
    const rng = makeRng(seed);
    const n = plants.length;
    this.pollenMax = new Float32Array(n);
    this.nectarMax = new Float32Array(n);
    this.pollen = new Float32Array(n);
    this.nectar = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = speciesList[plants[i].species].forage;
      const pMax = Math.max(MIN_SUPPLY, rng.gauss(f.pollen.avg, f.pollen.std));
      const nMax = Math.max(MIN_SUPPLY, rng.gauss(f.nectar.avg, f.nectar.std));
      this.pollenMax[i] = pMax;
      this.nectarMax[i] = nMax;
      this.pollen[i] = pMax * rng.range(MIN_FILL_FRACTION, 1);
      this.nectar[i] = nMax * rng.range(MIN_FILL_FRACTION, 1);
    }
    this.beePollen = 0;
    this.beeNectar = 0;
  }

  /**
   * Drain `plant`'s supply into the bee's cargo for `dt` seconds: an
   * exponential decay of whatever is left (see COLLECT_RATE), capped by the
   * bee's remaining capacity.
   */
  collect(plant, dt) {
    if (plant < 0 || plant >= this.pollen.length) return;
    const take = 1 - Math.exp(-COLLECT_RATE * dt);
    const pAmt = Math.min(this.pollen[plant] * take, BEE_CAPACITY - this.beePollen);
    const nAmt = Math.min(this.nectar[plant] * take, BEE_CAPACITY - this.beeNectar);
    if (pAmt > 0) { this.pollen[plant] -= pAmt; this.beePollen += pAmt; }
    if (nAmt > 0) { this.nectar[plant] -= nAmt; this.beeNectar += nAmt; }
  }
}

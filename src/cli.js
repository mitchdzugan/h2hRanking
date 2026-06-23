#!/usr/bin/env node

import * as $ from "@dz/-";
import { fs, path } from "@dz/-/node";
import * as R from "./index.js";

async function main() {
  const eventList = await fs.slurp(process.argv[2]);
  const ranks = await R.calcRankings(eventList, {
    cachePath: path.join(process.cwd(), ".h2hRanking-cache"),
  });
  for (const [rank, rankInd] of $.withInd(ranks)) {
    console.log(
      [
        `${rankInd + 1}.`,
        rank.name,
        ` [ ${rank.rating || "----"} ] `,
        `${rank.wins}-${rank.losses}`,
        ` ( ${rank.events} events ) `,
      ].join(" "),
    );
  }
}

$.execAndExit(main());

import { fileURLToPath } from "url";
import * as $ from "@dz/-";
import * as N from "@dz/-/node";
import challonge from "challonge";
import Challonge from "simple-challonge-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = N.path.dirname(__filename);

const queryDir = N.path.join(__dirname, "..", "gql");
const cachePath = N.path.join(__dirname, "..", ".gql-cache");
const apiUrl = `https://api.start.gg/gql/alpha`;
const authToken = process.env["CLM_STATS_GG_AUTH"];
const challongeApiKey = "2NxNZaAEJBHW7vGNGCXuVP1fUnBu7wTIcwePHmPX";

const gql = (queryName, vars, gqlOpts = {}) =>
  N.gqlRequest({
    cachePath,
    authToken,
    apiUrl,
    queryDir,
    queryName,
    vars,
    ...gqlOpts,
  });

async function qAll(query, constVars, pvSpecs, gqlOpts) {
  const pageVars = {};
  for (const pageVar in pvSpecs) {
    pageVars[pageVar] = 0;
  }
  const q = () => {
    const vars = { ...constVars, ...pageVars };
    return gql(query, vars, gqlOpts);
  };
  const data = await q();
  const pageVarNames = Object.keys(pvSpecs);
  pageVarNames.sort();
  for (const pageVar of pageVarNames) {
    const { getPageData = (d) => d, getId = (e) => e.id } = pvSpecs[pageVar];
    const total = getPageData(data).pageInfo.total;
    const ids = new Set(getPageData(data).nodes.map(getId));
    while (ids.size < total) {
      pageVars[pageVar]++;
      const next = await q();
      const preSize = ids.size;
      for (const el of getPageData(next).nodes) {
        const id = getId(el);
        if (!ids.has(id)) {
          getPageData(data).nodes.push(el);
        }
        ids.add(id);
      }
      if (preSize === ids.size && pageVars[pageVar] > 1) {
        const cvs = JSON.stringify(constVars);
        const pvs = JSON.stringify(pageVars);
        throw `nodes unchanged ${query} ${cvs} ${pageVar} ${pvs}`;
      }
    }
  }
  return data;
}

async function tryGetGGDataImpl(slug, q, gqlOpts) {
  return await qAll(
    q,
    { slug },
    {
      pageS: { getPageData: (d) => d.event.standings },
      pageE: { getPageData: (d) => d.event.entrants },
    },
    gqlOpts,
  );
}

async function tryGetGGData(slug, q, gqlOpts) {
  try {
    return await tryGetGGDataImpl(slug, q, gqlOpts);
  } catch (_e) {
    console.log(_e);
    return undefined;
  }
}

async function getBaseEventData(slug, gqlOpts) {
  let res;
  for (const plusOpts of [{ networkControl: "cache-only" }, {}]) {
    for (const q of ["tournamentData", "tournamentDataSmall"]) {
      if (res && res.event) {
        return res;
      }
      res = await tryGetGGData(slug, q, { ...plusOpts, ...gqlOpts });
    }
  }
  return res;
}

async function getEventDataImpl(slug, gqlOpts) {
  const dbr = (await getBaseEventData(slug, gqlOpts)) || {};
  const { event } = dbr;
  // console.log({ event });
  if (!event) {
    return undefined;
  }
  event.tournamentName = event.tournament.name;
  event.date = event.tournament.endAt;
  event.imageUrl = (
    event.tournament.images.filter((i) => i.type === "profile")[0] || {}
  ).url;
  event.prPeriod = 14;
  for (const entrant of event.entrants.nodes) {
    for (const ptc of entrant.participants) {
      const player = ptc.player;
      const user = player.user || { name: player.gamerTag };
      player.name = user.name;
      player.pronouns = user.genderPronoun || "";
    }
  }
  const phaseGroups = [...event.phaseGroups];
  phaseGroups.sort((g1, g2) => g1.phase.phaseOrder - g2.phase.phaseOrder);
  // console.log({ phaseGroups });
  for (const _pg of phaseGroups) {
    _pg.sets = {};
    let page = 0;
    const data = await gql(
      "setsData",
      { phaseGroupId: `${_pg.id}`, page },
      gqlOpts,
    );
    const total = data.phaseGroup.sets.pageInfo.total;
    const ids = new Set([]);
    while (ids.size < total) {
      page++;
      // console.log([ids.size, total]);
      const next = await gql(
        "setsData",
        { phaseGroupId: `${_pg.id}`, page },
        gqlOpts,
      );
      for (const set of next.phaseGroup.sets.nodes) {
        if (!ids.has(set.id)) {
          ids.add(set.id);
          data.phaseGroup.sets.nodes.push(set);
        }
      }
    }
    const pg = data.phaseGroup;
    for (const set of pg.sets.nodes) {
      set.hasWinner = !!set.winnerId;
      set.isDQ = set.displayScore === "DQ";
      set.isBye = false;
      for (const slot of set.slots) {
        if (!slot.entrant) {
          set.isBye = true;
          break;
        }
      }
      set.doesCount = !set.isBye && !set.isDQ && set.hasWinner;
      _pg.sets[set.id] = set;
    }
  }
  return event;
}

async function main() {
  console.log(queryDir);
  const eventData = await getEventDataImpl(
    "tournament/the-botlane-show-9-unsure/event/melee-singles",
    {},
  );
  console.log(eventData);
  const challongeClient = challonge.createClient({ apiKey: challongeApiKey });
  console.log(challongeClient);
  const client = new Challonge({
    username: "dz8292",
    apiKey: challongeApiKey,
    tournamentID: "tz6op7p6",
  });
  console.log(client);
}

$.execAndExit(main());

import { WholeHistoryRating } from "whr";
import { firefox } from "playwright-core";
import * as $ from "@dz/-";
import * as N from "@dz/-/node";

const ggApiUrl = `https://api.start.gg/gql/alpha`;
const gql = (queryName, vars, gqlOpts = {}) =>
  N.gqlRequest({
    apiUrl: ggApiUrl,
    queryName,
    vars,
    ...gqlOpts,
  });

export async function ggQueryAll(query, constVars, pvSpecs, gqlOpts = {}) {
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
  return await ggQueryAll(
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
    return undefined;
  }
}

async function getBaseGGEventData(slug, gqlOpts) {
  let res;
  const cacheOnly = { networkControl: N.GQLNetworkControl.cacheOnly };
  for (const plusOpts of [cacheOnly, {}]) {
    for (const q of ["tournamentData", "tournamentDataSmall"]) {
      if (res && res.event) {
        return res;
      }
      res = await tryGetGGData(slug, q, { ...plusOpts, ...gqlOpts });
    }
  }
  return res;
}

export async function getGGEventData(slug, gqlOpts = {}) {
  const dbr = (await getBaseGGEventData(slug, gqlOpts)) || {};
  const { event } = dbr;
  if (!event) {
    return undefined;
  }
  event.bracketingSite = "startgg";
  event.tournamentName = event.tournament.name;
  event.date = event.tournament.endAt;
  event.imageUrl = (
    event.tournament.images.filter((i) => i.type === "profile")[0] || {}
  ).url;
  event.prPeriod = 14;
  const entrantNodes = event.entrants.nodes;
  event.entrants = {};
  for (const entrantNode of entrantNodes) {
    event.entrants[entrantNode.id] = entrantNode;
    for (const ptc of entrantNode.participants) {
      const player = ptc.player;
      const user = player.user || { name: player.gamerTag };
      player.name = user.name;
      player.pronouns = user.genderPronoun || "";
      entrantNode.player = player;
    }
  }
  const phaseGroups = [...event.phaseGroups];
  phaseGroups.sort((g1, g2) => g1.phase.phaseOrder - g2.phase.phaseOrder);
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

      const [slot1, slot2] = set.slots;
      const [slot1Score, slot2Score] = (() => {
        const games = set.games || [];
        if (games.length) {
          const doneGamesL = games.filter((g) => !!g.winnerId);
          const w1GamesL = games.filter((g) => g.winnerId === slot1.entrant.id);
          const w1 = `${w1GamesL.length}`;
          const w2 = `${doneGamesL.length - w1GamesL.length}`;
          return [w1, w2];
        }

        function getDisplayName(slot) {
          const entrant = event.entrants[slot.entrant.id] || {};
          const { gamerTag, prefix } = entrant.player || {};
          return [prefix ? `${prefix} | ` : "", gamerTag].join("");
        }
        return (() => {
          if (set.displayScore === "DQ") {
            return set.winnerId == slot1.entrant.id ? ["-", "DQ"] : ["DQ", "-"];
          }
          if (!set.displayScore) {
            return ["", ""];
          }

          const s2m = [...set.displayScore.matchAll(/ (\d+)$/g)];
          if (s2m.length === 1) {
            const s2 = s2m[0][1];
            const s1m = [...set.displayScore.matchAll(/ (\d+) -/g)];
            if (s1m.length === 1) {
              const res = [s1m[0][1], s2];
              return res;
            }
          }

          return set.displayScore
            .split(getDisplayName(slot1))[1]
            .split("- " + getDisplayName(slot2))
            .map((s) => s.trim());
        })();
      })();

      set.slots[0].displayScore = slot1Score;
      set.slots[1].displayScore = slot2Score;

      function scoreOf(displayScore) {
        const res = parseInt(displayScore);
        return Number.isNaN(res) ? undefined : res;
      }

      set.slots[0].score = scoreOf(slot1Score);
      set.slots[1].score = scoreOf(slot2Score);

      set.doesCount = !set.isBye && !set.isDQ && set.hasWinner;
      _pg.sets[set.id] = set;
    }
  }

  for (const { entrant, id, ...standing } of event.standings.nodes) {
    $.assertNonNil(event.entrants[entrant.id]);
    event.entrants[entrant.id].standing = standing;
  }
  delete event.standings;

  return event;
}

function mkContext(headless = true) {
  const args = ["--disable-blink-features=AutomationControlled"];
  return firefox.launch({
    headless,
    args,
    viewport: { width: 1920, height: 720 },
  });
}

export async function getChallongeEventData(slug, gqlOpts = {}) {
  const challongeId = `CHALLONGE-${slug}`;
  const slugCachePath = N.path.join(gqlOpts.cachePath, `${challongeId}.json`);
  if (gqlOpts.networkControl !== N.GQLNetworkControl.forceFetch) {
    const cached = await N.fs.slurp(slugCachePath);
    if (cached) {
      return cached;
    }
  }
  if (gqlOpts.networkControl === N.GQLNetworkControl.cacheOnly) {
    return undefined;
  }
  const event = { bracketingSite: "challonge" };
  const browser = await mkContext(gqlOpts.headless);
  const page = await browser.newPage();

  const mkApplyToLoc =
    (k) =>
    (...args) => {
      const [loc, base] = (() => {
        if (args.length > 1) {
          return args;
        }
        if (args.length === 0) {
          return ["", page];
        }
        if (typeof args[0] === "string") {
          return [args[0], page];
        }
        return ["", args[0]];
      })();
      return (loc ? base.locator(loc) : base)[k]().then((s) => s.trim());
    };

  const getInnerText = mkApplyToLoc("innerText");
  const getInnerHTML = mkApplyToLoc("innerHTML");
  async function getInnerHTMLAsInt(...args) {
    try {
      const res = await getInnerHTML(...args).then((s) => parseInt(s));
      return !Number.isNaN(res) ? res : undefined;
    } catch (_e) {
      return undefined;
    }
  }

  await page.goto(`https://challonge.com/${slug}`, { timeout: 120_000 });
  const entrants = {};
  const sets = {};
  let isDE = false;
  for (const itemEl of await page
    .locator(".redesigned-meta-list .item")
    .all()) {
    const itemLabel = await getInnerText(".item-label", itemEl);
    if (itemLabel === "Start Time") {
      const dateStr = await getInnerText(".text", itemEl);
      const [mStr, dStr, yStr] = dateStr.split(" ");
      const month = {
        January: 0,
        February: 1,
        March: 2,
        April: 3,
        May: 4,
        June: 5,
        July: 6,
        August: 7,
        September: 8,
        October: 9,
        November: 10,
        December: 11,
      }[mStr];
      const day = parseInt(dStr.split(",")[0]);
      const year = parseInt(yStr);
      event.date = Math.floor(new Date(year, month, day, 12).valueOf() / 1000);
    }
    if (itemLabel === "Game") {
      event.name = await getInnerText(".text", itemEl);
    }
    if (itemLabel === "Format") {
      isDE = (await getInnerText(".text", itemEl)) === "Double Elimination";
    }
  }
  event.tournamentName = await getInnerText(".title #title");
  for (const bracketEl of await page.locator(".bracket-svg").all()) {
    const matchEls = await bracketEl.locator(".match").all();
    for (const matchEl of matchEls) {
      const setId = await matchEl.getAttribute("data-match-id");
      const set = { id: setId, slots: [] };
      const playerEls = await matchEl.locator(".match--player").all();
      for (const playerEl of playerEls) {
        const entrantId = await playerEl.getAttribute("data-participant-id");
        const playerName = await getInnerHTML("title", playerEl);
        const playerId = `CH-${playerName}`;
        const playerBase = {
          gamerTag: playerName,
          name: playerName,
          prefix: null,
        };
        entrants[entrantId] ||= {
          id: entrantId,
          participants: [
            { ...playerBase, player: { ...playerBase, id: playerId } },
          ],
        };
        const scoreEl = playerEl.locator(".match--player-score");
        const scoreClass = await scoreEl.getAttribute("class");
        scoreClass.split(" ").forEach((classPart) => {
          set.winnerId ||= classPart !== "-winner" ? undefined : entrantId;
        });
        const score = await getInnerHTMLAsInt(scoreEl);
        const slot = { entrant: { id: entrantId }, score };
        set.slots.push(slot);
      }
      sets[setId] = set;
    }
  }
  event.entrants = entrants;
  const setList = Object.values(sets);
  setList.sort((s1, s2) => parseInt(s2.id) - parseInt(s1.id));
  let lastSet = null;
  let wasGrands = false;
  let isLosers = false;
  function slotsKey(set) {
    const entrantIds = set.slots.map((slot) => slot.entrant.id);
    entrantIds.sort();
    return entrantIds.join("|");
  }

  const isComplete = (() => {
    for (const set of setList) {
      if (!set.winnerId) {
        return false;
      }
    }
    return true;
  })();

  const gfEntrants = new Set();
  const nonGfEntrants = new Set();
  let depth = 0;
  let roundInd = 0;
  let isDropRound = true;
  for (const set of setList) {
    const isGrands =
      (!lastSet && isDE) || (wasGrands && slotsKey(set) === slotsKey(lastSet));
    if (isGrands && wasGrands) {
      lastSet.round.isLosers = true;
    }
    set.slots.forEach((slot) =>
      (isGrands ? gfEntrants : nonGfEntrants).add(slot.entrant.id),
    );
    let seenAllGFEntrants = true;
    gfEntrants.forEach((e) => (seenAllGFEntrants &&= nonGfEntrants.has(e)));
    isLosers ||= !isGrands && wasGrands;
    const wasLosers = isLosers;
    isLosers &&= !seenAllGFEntrants;
    if ((!isLosers && wasLosers) || (!isGrands && wasGrands)) {
      depth = roundInd = 0;
    }
    const slotName = (slot) => entrants[slot.entrant.id].participants[0].name;
    const slotScore = (slot) =>
      slot.score === undefined ? "" : `${slotName(slot)} ${slot.score}`;
    set.slots.forEach(
      (slot) =>
        (slot.displayScore =
          slot.score === undefined ? undefined : `${slot.score}`),
    );
    set.slots.forEach(
      (slot) =>
        (slot.playerId = entrants[slot.entrant.id].participants[0].player.id),
    );
    set.displayScore = set.slots.map(slotScore).join(" - ");
    set.round = { isGrands, isLosers, depth, isDropRound };
    set.roundInd = roundInd;
    set.doesCount = isComplete;
    const [slot1, slot2] = set.slots;
    const is1w = set.winnerId === slot1.entrant.id;
    const wId = is1w ? slot1.entrant.id : slot2.entrant.id;
    const lId = is1w ? slot2.entrant.id : slot1.entrant.id;
    if (isComplete) {
      if (isGrands && !wasGrands) {
        event.entrants[wId].standing = { placement: 1, isFinal: true };
        event.entrants[lId].standing = { placement: 2, isFinal: true };
      } else if (isLosers) {
        const p2Inc = Math.pow(2, depth + 1);
        event.entrants[lId].standing = {
          placement: 1 + (isDropRound ? p2Inc : Math.floor((3 * p2Inc) / 2)),
          isFinal: true,
        };
      } else if (!isDE) {
        if (!depth) {
          event.entrants[wId].standing = { placement: 1, isFinal: true };
        }
        event.entrants[lId].standing = {
          placement: Math.pow(2, depth) + 1,
          isFinal: true,
        };
      }
    }

    roundInd++;
    if (Math.pow(2, depth) === roundInd) {
      roundInd = 0;
      if (isDropRound && isLosers) {
        isDropRound = false;
      } else {
        isDropRound = true;
        depth++;
      }
    }

    wasGrands = isGrands;
    lastSet = set;
  }
  event.phaseGroups = [
    {
      id: 1,
      phase: { id: 1, name: "Bracket", phaseOrder: 1 },
      displayIdentifier: "1",
      sets,
    },
  ];

  function roundNum(set) {
    const round = set.round;
    if (round.isGrands) {
      return 0;
    }
    if (round.isLosers) {
      return 2 * round.depth + (round.isDropRound ? 0 : 1);
    }
    return round.depth;
  }

  let maxRoundNumW = 0;
  let maxRoundNumL = 0;

  for (const set of Object.values(sets)) {
    if (set.round.isLosers) {
      maxRoundNumL = Math.max(maxRoundNumL, roundNum(set));
    } else {
      maxRoundNumW = Math.max(maxRoundNumW, roundNum(set));
    }
  }

  function roundLabel(set) {
    const round = set.round;
    if (round.isGrands) {
      return round.isLosers ? "Finals (reset)" : "Finals";
    }
    if (round.isLosers) {
      return `Losers Round ${maxRoundNumL - roundNum(set) + 1}`;
    }
    if (round.depth === 0) {
      return isDE ? "Semifinals" : "Finals";
    }
    if (!isDE && round.depth === 1) {
      return "Semifinals";
    }
    return `Round ${maxRoundNumW - roundNum(set) + 1}`;
  }

  for (const set of Object.values(sets)) {
    set.fullRoundText = roundLabel(set);
  }

  event.prPeriod = 14;
  event.imageUrl = "https://i.imgur.com/7MsdKge.jpeg";
  event.state = isComplete ? "COMPLETED" : "ACTIVE";
  event.slug = slug;
  event.id = `CHALLONGE-${slug}`;
  event.numEntrants = Object.values(event.entrants).length;
  event.tournament = {
    id: event.slug,
    name: event.tournamentName,
    endAt: event.date,
    images: [{ type: "profile", url: event.imageUrl }],
  };
  if (isComplete) {
    await N.fs.spit(slugCachePath, event);
  }
  return event;
}

const _l = (a, fb) => (!a || !a.length ? fb : a[a.length - 1]);

export async function calcRankings(eventList, gqlOpts = {}) {
  const events = await Promise.all(
    eventList.map(({ slug, isChallonge }) => {
      console.error("Getting data for", { slug }, "...");
      return (isChallonge ? getChallongeEventData : getGGEventData)(
        slug,
        gqlOpts,
      );
    }),
  );
  events.sort((e1, e2) => e1.date - e2.date);
  const setGroups = [];
  const players = {};
  for (const event of events) {
    for (const entrant of Object.values(event.entrants)) {
      const player = entrant.participants[0].player;
      players[player.id] ||= player;
      players[player.id].events ||= 0;
      players[player.id].events++;
      players[player.id].wins = 0;
      players[player.id].losses = 0;
    }
    setGroups.push([]);
    for (const phaseGroup of event.phaseGroups) {
      const sets = Object.values(phaseGroup.sets);
      sets.sort((s1, s2) => parseInt(s1.id) - parseInt(s2.id));
      for (const set of sets) {
        _l(setGroups).push(set);
      }
    }
  }

  const whr = new WholeHistoryRating({ w2: 20 });
  const whrKey = (playerId) => `player::[ ${playerId} ]`;

  for (const [setGroup, groupNum] of $.withInd(setGroups)) {
    for (const set of setGroup) {
      if (!set.doesCount) {
        continue;
      }
      const [wPId, lPId] =
        set.winnerId === set.slots[0].entrant.id
          ? [set.slots[0].playerId, set.slots[1].playerId]
          : [set.slots[1].playerId, set.slots[0].playerId];
      const wkey = whrKey(wPId);
      const lkey = whrKey(lPId);
      players[wPId].wins++;
      players[lPId].losses++;
      whr.createGame(wkey, lkey, "B", groupNum, 0);
    }
  }
  whr.iterate(100);

  for (const player of Object.values(players)) {
    const ratings = whr.ratingsForPlayer(whrKey(player.id));
    if (!ratings.length) {
      player.hasRating = false;
      continue;
    }
    player.hasRating = true;
    player.rating = _l(ratings)[1] + 1000;
  }

  const ranks = Object.values(players);
  ranks.sort((p1, p2) => p2.rating - p1.rating);

  return [
    ...ranks.filter((p) => p.hasRating),
    ...ranks.filter((p) => !p.hasRating),
  ];
}

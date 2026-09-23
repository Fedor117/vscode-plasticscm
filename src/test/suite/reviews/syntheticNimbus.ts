import { ISyntheticReview, SyntheticPlasticServer } from "./syntheticServer";

/**
 * The synthetic Nimbus repository the end-to-end suite runs against: every
 * review the suite opens is built here on purpose, and everything else it
 * expects is read from the model. Names, paths and text are made up.
 */

export const ME = "dana.kim@example.com";
export const PRIYA = "priya.nair@example.com";
export const LENA = "lena.park@example.com";
export const SAM = "sam.rivera@example.com";
export const NOOR = "noor.haddad@example.com";
export const OMAR = "omar.farouk@example.com";
const OTHERS = [ PRIYA, LENA, SAM, NOOR, OMAR ];

export const MAIN = "/main";

/** An Overview the suite checks, and whom it waits on. */
export interface IOverviewTarget {
  id: number;
  /** The reviewers it waits on, the longest waiting first; empty when it waits on none. */
  waitingOn: string[];
  /** Rework was asked for, so it waits on its author. */
  rework: boolean;
}

export interface INimbusScenario {
  server: SyntheticPlasticServer;
  /**
   * A visible branch whose title the author wrote: anchored threads on a
   * changed, a deleted and an added row, on both sides of the moved one and
   * on a merged one, two merges from /main, a directory row, and reviewers
   * requested in both formats, removed and requested again.
   */
  branchReview: { id: number; branch: string };
  /** A hidden branch whose title the author wrote: only the hidden branch query names it. */
  namedHiddenReview: { id: number; branch: string };
  /** An open review of a hidden branch, owned by the cm user: a merge, more than 50 changesets, anchored threads. */
  hiddenReview: { id: number; branchId: number };
  /** An open review of one changeset on a hidden branch, owned by the cm user, waiting on one of three reviewers. */
  changesetReview: { id: number; changeset: number };
  /** Reviewed, of a hidden branch: a verdict with text and a reply to it, text-less verdicts, a General thread. */
  verdictReview: {
    id: number;
    verdictThread: number;
    verdictText: string;
    replyToVerdict: number;
    replyText: string;
    generalThread: number;
  };
  /** A visible-branch review whose comment line the final revision no longer has, with a verdict text. */
  outdatedReview: { id: number; verdictText: string };
  /** A branch review whose branch was deleted. */
  deletedReview: { id: number; branchId: number };
  overviewReviews: IOverviewTarget[];
}

const CRLF = { eol: "\r\n" as const };
const BOM = { bom: true };

/** A synthetic date in the +01:00 zone every synthetic date uses. */
function at(day: number, time: string): string {
  return `2026-09-${day < 10 ? "0" : ""}${day}T${time}+01:00`;
}

function shifted(date: string, minutes: number): string {
  const time = new Date(Date.parse(date) + (minutes + 60) * 60 * 1000).toISOString();
  return time.replace(/\.\d{3}Z$/, "+01:00");
}

function info(owner: string, date: string, comment: string): { owner: string; date: string; comment: string } {
  return { comment, date, owner };
}

/** A file's lines, each one different, so a thread on the wrong line reads the wrong text. */
function source(file: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `// ${file} line ${index + 1} · first revision`);
}

/** `count` lines from `from` (zero-based) rewritten in changeset `cs`; the rest stay as they were. */
function rewrite(lines: string[], from: number, count: number, cs: number): string[] {
  return lines.map((line, index) => (index >= from && index < from + count
    ? line.replace(/ · .*$/, ` · rewritten in cs:${cs}`) : line));
}

/** `count` new lines inserted before line `before` (zero-based) in changeset `cs`. */
function insert(lines: string[], before: number, count: number, cs: number): string[] {
  const file = lines[0].replace(/ line \d+ · .*$/, "");
  const added = Array.from({ length: count }, (_, index) => `${file} added line ${index + 1} · cs:${cs}`);
  return lines.slice(0, before).concat(added, lines.slice(before));
}

export function nimbusRepository(root: string): INimbusScenario {
  const server = new SyntheticPlasticServer(root, ME, "Nimbus", "acme-studio@unity", MAIN);
  const review = (row: ISyntheticReview) => server.addReview(row);
  const timeline = (id: number, owner: string, date: string, text: string) =>
    server.addTimeline(id, owner, date, text);

  // /main: the imported project, and the changes the branches below merge from it.
  server.addBranch({
    base: -1, comment: "Main line", date: "2026-08-03T08:55:00+01:00", id: 10, name: MAIN, owner: SAM,
  });
  const imported = server.checkin(MAIN, info(SAM, "2026-08-03T09:00:00+01:00", "Initial import of the Nimbus project"));
  const lapTimer = imported.add("/Assets/Code/Laps/LapTimer.cs", source("LapTimer.cs", 60), { ...CRLF, ...BOM });
  const lapStore = imported.add("/Assets/Code/Laps/LapTimesStore.cs", source("LapTimesStore.cs", 30));
  const trackSettings = imported.add("/Assets/Code/Track/TrackSettings.cs", source("TrackSettings.cs", 40));
  const sectorClock = imported.add("/Prototypes/Timing/SectorClock.cs", source("SectorClock.cs", 35));
  const raceSession = imported.add("/Assets/Code/Race/RaceSession.cs", source("RaceSession.cs", 50));
  const startLights = imported.add("/Assets/Code/Race/StartLights.cs", source("StartLights.cs", 25));
  const pitPlanner = imported.add("/Assets/Code/Pit/PitStopPlanner.cs", source("PitStopPlanner.cs", 45), CRLF);
  const tyreWear = imported.add("/Assets/Data/Tuning/TyreWear.json",
    Array.from({ length: 60 }, (_, index) => `  "stint_${index + 1}": ${(0.5 + index / 100).toFixed(2)},`));
  const speedGauge = imported.add("/Assets/UI/Hud/SpeedGauge.cs", source("SpeedGauge.cs", 30));
  const setupSheet = imported.add("/Assets/Code/Garage/SetupSheet.cs", source("SetupSheet.cs", 40));
  const engineMixer = imported.add("/Assets/Code/Audio/EngineMixer.cs", source("EngineMixer.cs", 40), BOM);
  const oldMixer = imported.add("/Assets/Code/Audio/OldMixer.cs", source("OldMixer.cs", 20));
  const brakeAssist = imported.add("/Assets/Code/Physics/BrakeAssist.cs", source("BrakeAssist.cs", 30));
  const crashReporter = imported.add("/Assets/Code/Telemetry/CrashReporter.cs", source("CrashReporter.cs", 30));
  const countdown = server.checkin(MAIN, info(PRIYA, "2026-08-05T10:00:00+01:00",
    "Race session: countdown before the green flag"));
  countdown.change(raceSession, lines => rewrite(lines, 4, 2, countdown.id));

  // branchReview: every kind of row, two merges from /main, a directory, threads on both sides.
  const LAP_TIMER = "/main/RAC-812_lap-timer";
  server.addBranch({
    base: countdown.id, comment: "RAC-812 lap timer accuracy", date: at(14, "09:50:00"), id: 11, name: LAP_TIMER,
    owner: SAM,
  });
  const sectors = server.checkin(LAP_TIMER, info(SAM, at(14, "10:00:00"),
    "RAC-812 lap timer: split sectors and keep laps in the session"));
  sectors.change(lapTimer, lines => insert(rewrite(lines, 9, 3, sectors.id), 30, 4, sectors.id));
  sectors.remove(lapStore);
  const lapDisplay = sectors.add("/Assets/Code/Laps/LapTimerDisplay.cs", source("LapTimerDisplay.cs", 25));
  sectors.addDirectory("/Assets/Code/Laps/Splits");
  sectors.move(sectorClock, "/Assets/Code/Laps/Splits/SectorClock.cs", lines => rewrite(lines, 4, 2, sectors.id));
  const pitLane = server.checkin(MAIN, info(PRIYA, at(14, "15:00:00"), "Track settings: pit lane speed limit"));
  pitLane.change(trackSettings, lines => rewrite(lines, 19, 3, pitLane.id));
  server.merge(LAP_TIMER, pitLane.id, info(SAM, at(15, "09:00:00"), "Merge from main"), [trackSettings]);
  const damping = server.checkin(MAIN, info(LENA, at(15, "11:00:00"), "HUD: speed gauge needle damping"));
  damping.change(speedGauge, lines => rewrite(lines, 10, 2, damping.id));
  server.merge(LAP_TIMER, damping.id, info(SAM, at(15, "14:00:00"), "Merge from main"), [speedGauge]);
  const splitTimes = server.checkin(LAP_TIMER, info(SAM, at(16, "10:00:00"), "RAC-812 lap timer: format split times"));
  splitTimes.change(lapTimer, lines => rewrite(lines, 44, 1, splitTimes.id));

  const branchReview = 301;
  review({
    assignee: ME, date: at(14, "10:30:00"), id: branchReview, owner: SAM, status: "Under review", target: 11,
    targetType: "Branch", title: "Lap timer accuracy",
  });
  timeline(branchReview, SAM, at(14, "10:30:05"),
    `[renamed-title]Review of branch ${LAP_TIMER}#->#Lap timer accuracy`);
  // Both request formats, written as a pair in the same second.
  timeline(branchReview, SAM, at(14, "10:31:00"), `[requested-review-from]${PRIYA}`);
  timeline(branchReview, SAM, at(14, "10:31:00"), `[requested-review-from-${PRIYA}]`);
  timeline(branchReview, SAM, at(14, "10:32:00"), `[requested-review-from]${LENA}`);
  timeline(branchReview, SAM, at(14, "10:33:00"), `[requested-review-from]${OMAR}`);
  timeline(branchReview, SAM, at(14, "10:40:00"), `[removed-requested-review-from]${LENA}`);
  timeline(branchReview, SAM, at(14, "10:41:00"), `[removed-requested-review-from]${OMAR}`);
  // A self-request without a verdict.
  timeline(branchReview, NOOR, at(15, "12:00:00"), `[requested-review-from]${NOOR}`);
  timeline(branchReview, SAM, at(16, "11:00:00"), `[re-requested-review-from]${LENA}`);
  const onChanged = { location: 44, revision: server.revisionAt(lapTimer, splitTimes.id), type: "change" };
  server.addComment(branchReview, PRIYA, at(16, "12:00:00"),
    "Use the invariant culture when formatting split times.", onChanged);
  const onDeleted = server.addComment(branchReview, LENA, at(16, "12:05:00"),
    "Where do saved laps live now that the store is gone?",
    { location: 6, revision: server.revisionAt(lapStore, countdown.id), type: "question" });
  server.addComment(branchReview, SAM, at(16, "12:20:00"), "In RaceSession, one list per session.",
    { parent: onDeleted });
  server.addComment(branchReview, NOOR, at(16, "12:10:00"), "Nice and small.",
    { location: 2, revision: server.revisionAt(lapDisplay, sectors.id), type: "comment" });
  server.addComment(branchReview, PRIYA, at(16, "12:15:00"), "This tick rate belongs in the tuning data.",
    { location: 7, revision: server.revisionAt(sectorClock, countdown.id), type: "change" });
  // On the moved row's right side, whose path is the branch's, not the one /main still has.
  server.addComment(branchReview, NOOR, at(16, "12:16:00"), "Should sector two end at the second timing beam?",
    { location: 5, revision: server.revisionAt(sectorClock, sectors.id), type: "question" });
  server.addComment(branchReview, ME, at(16, "12:30:00"), "Was the 60 Hz fallback here on purpose?",
    { location: 19, revision: server.revisionAt(lapTimer, countdown.id), type: "question" });
  server.addComment(branchReview, LENA, at(16, "12:35:00"), "Clamp the pit lane limit to 80 km/h.",
    { applied: splitTimes.id, location: 20, revision: server.revisionAt(trackSettings, pitLane.id), type: "change" });
  const conversation = server.addComment(branchReview, SAM, at(16, "13:00:00"),
    "Ready for another look after the merge from main.", { type: "conversation" });
  server.addComment(branchReview, PRIYA, at(16, "13:10:00"), "Looking now.", { parent: conversation });

  // namedHiddenReview: a hidden branch only the hidden branch query names.
  const START_LIGHTS = "/main/RAC-845_start-lights";
  server.addBranch({
    base: countdown.id, comment: "RAC-845 start lights", date: at(20, "10:50:00"), hidden: true, id: 12,
    name: START_LIGHTS, owner: LENA,
  });
  const gantry = server.checkin(START_LIGHTS, info(LENA, at(20, "11:00:00"), "RAC-845 start lights: 5-light gantry"));
  gantry.change(startLights, lines => rewrite(lines, 3, 5, gantry.id));
  review({
    assignee: "", date: at(20, "11:30:00"), id: 302, owner: LENA, status: "Under review", target: 12,
    targetType: "Branch", title: "Start lights sequence",
  });

  // hiddenReview: a hidden branch of the cm user's with a merge and more than a page of changesets.
  const PIT = "/main/RAC-860_pit-strategy";
  server.addBranch({
    base: damping.id, comment: "RAC-860 pit strategy", date: at(16, "10:50:00"), hidden: true, id: 13, name: PIT,
    owner: ME,
  });
  const plan = server.checkin(PIT, info(ME, at(16, "11:00:00"), "RAC-860 pit strategy: plan stops from tyre wear"));
  plan.change(pitPlanner, lines => rewrite(rewrite(lines, 9, 2, plan.id), 29, 2, plan.id));
  plan.change(raceSession, lines => rewrite(lines, 20, 2, plan.id));
  const redline = server.checkin(MAIN, info(LENA, at(16, "13:00:00"), "HUD: speed gauge redline marker"));
  redline.change(speedGauge, lines => rewrite(lines, 20, 2, redline.id));
  server.merge(PIT, redline.id, info(ME, at(16, "14:00:00"), "Merge from main"), [speedGauge]);
  for (let stint = 0; stint < 52; stint++) {
    const tuning = server.checkin(PIT, info(ME, shifted(at(16, "15:00:00"), stint * 10),
      `RAC-860 tuning: stint ${stint + 1} wear rate`));
    tuning.change(tyreWear, lines => lines.map((line, index) => (index === stint
      ? `  "stint_${stint + 1}": ${(0.6 + stint / 100).toFixed(2)}, // cs:${tuning.id}` : line)));
  }
  const undercut = server.checkin(PIT, info(ME, at(17, "12:00:00"), "RAC-860 pit strategy: undercut window"));
  undercut.change(pitPlanner, lines => rewrite(lines, 39, 2, undercut.id));

  const hiddenReview = 303;
  review({
    assignee: "", date: at(16, "11:30:00"), id: hiddenReview, owner: ME, status: "Under review", target: 13,
    targetType: "Branch", title: "Pit strategy planner",
  });
  timeline(hiddenReview, ME, at(16, "11:31:00"), `[requested-review-from]${PRIYA}`);
  timeline(hiddenReview, ME, at(16, "11:32:00"), `[requested-review-from]${SAM}`);
  const pitHead = server.revisionAt(pitPlanner, undercut.id);
  server.addComment(hiddenReview, PRIYA, at(17, "13:00:00"), "Read the pit loss from the track data.",
    { location: 4, revision: pitHead, type: "change" });
  server.addComment(hiddenReview, SAM, at(17, "13:10:00"), "Does the undercut window include the out lap?",
    { location: 24, revision: pitHead, type: "question" });
  server.addComment(hiddenReview, OMAR, at(17, "13:20:00"), "The session already knows the lap count here.",
    { location: 11, revision: server.revisionAt(raceSession, damping.id), type: "comment" });
  // On a revision that is neither side: its line maps onto the head unchanged.
  server.addComment(hiddenReview, LENA, at(16, "12:00:00"), "Round the stop lap down, not up.",
    { location: 14, revision: server.revisionAt(pitPlanner, plan.id), type: "change" });

  // changesetReview: one changeset of a hidden branch, every kind of row, a binary file.
  const AUDIO = "/main/RAC-871_engine-audio";
  server.addBranch({
    base: redline.id, comment: "RAC-871 engine audio", date: at(18, "08:50:00"), hidden: true, id: 14, name: AUDIO,
    owner: ME,
  });
  const prepare = server.checkin(AUDIO, info(ME, at(18, "09:00:00"), "RAC-871 engine audio: prepare the mixer"));
  prepare.change(engineMixer, lines => rewrite(lines, 5, 2, prepare.id));
  const crossfadeComment = "RAC-871 engine audio: crossfade the RPM layers\n" +
    "The idle and redline samples now blend over 400 rpm.\nEngineMixer.cs replaces OldMixer.cs.";
  const crossfade = server.checkin(AUDIO, info(ME, at(18, "11:00:00"), crossfadeComment));
  crossfade.change(engineMixer, lines => rewrite(lines, 15, 3, crossfade.id));
  crossfade.addDirectory("/Assets/Audio/Engine");
  const rpmLayers = crossfade.add("/Assets/Audio/Engine/RpmLayers.asset", source("RpmLayers.asset", 20));
  crossfade.addBinary("/Assets/Audio/Engine/redline.wav", Buffer.from("RIFF synthetic redline sample", "utf8"));
  crossfade.remove(oldMixer);

  const changesetReview = 304;
  review({
    assignee: "", date: at(18, "11:30:00"), id: changesetReview, owner: ME, status: "Under review",
    target: crossfade.id, targetType: "Changeset", title: `Review of changeset ${crossfade.id}`,
  });
  timeline(changesetReview, ME, at(18, "11:31:00"), `[requested-review-from]${PRIYA}`);
  timeline(changesetReview, ME, at(18, "11:31:30"), `[requested-review-from]${OMAR}`);
  timeline(changesetReview, ME, at(18, "11:32:00"), `[requested-review-from]${LENA}`);
  timeline(changesetReview, PRIYA, at(18, "13:00:00"), "[status-reviewed]Crossfade sounds right on the test rig.");
  timeline(changesetReview, OMAR, at(18, "14:00:00"), "[status-reviewed]");
  server.addComment(changesetReview, LENA, at(18, "15:00:00"), "Should the redline layer fade out above 9000 rpm?",
    { location: 3, revision: server.revisionAt(rpmLayers, crossfade.id), type: "question" });

  // verdictReview: Reviewed; verdicts with and without text, a duplicate status pair, a reply to a verdict.
  const TELEMETRY = "/main/RAC-880_crash-telemetry";
  server.addBranch({
    base: redline.id, comment: "RAC-880 crash telemetry", date: at(18, "13:50:00"), hidden: true, id: 15,
    name: TELEMETRY, owner: NOOR,
  });
  const upload = server.checkin(TELEMETRY, info(NOOR, at(18, "14:00:00"),
    "RAC-880 crash telemetry: upload minidumps in the background"));
  upload.change(crashReporter, lines => rewrite(lines, 7, 3, upload.id));
  upload.add("/Assets/Code/Telemetry/UploadQueue.cs", source("UploadQueue.cs", 28));

  const verdictReview = 305;
  review({
    assignee: PRIYA, date: at(18, "14:30:00"), id: verdictReview, owner: NOOR, status: "Reviewed", target: 15,
    targetType: "Branch", title: "Crash telemetry upload",
  });
  timeline(verdictReview, NOOR, at(18, "15:00:00"), `[requested-review-from]${PRIYA}`);
  timeline(verdictReview, NOOR, at(18, "15:00:00"), `[requested-review-from-${PRIYA}]`);
  timeline(verdictReview, NOOR, at(18, "15:00:05"), `[requested-review-from]${SAM}`);
  // Without text: the activity log has it, General does not.
  timeline(verdictReview, PRIYA, at(19, "09:00:00"), "[status-rework-required]");
  const generalThread = server.addComment(verdictReview, SAM, at(19, "09:30:00"),
    "Can we keep the old uploader behind a flag for one release?", { type: "conversation" });
  server.addComment(verdictReview, NOOR, at(19, "10:00:00"), "Yes, it is behind crash.legacyUpload.",
    { parent: generalThread });
  const verdictText = "Looks good now, thanks for the fixes.";
  const verdictThread = timeline(verdictReview, PRIYA, at(19, "16:00:00"), `[status-reviewed]${verdictText}`);
  const replyText = "Merging after the nightly build.";
  const replyToVerdict = server.addComment(verdictReview, NOOR, at(19, "16:30:00"), replyText,
    { parent: verdictThread });
  // A duplicate status pair: the same verdict once without its text and once with it, a second apart.
  timeline(verdictReview, SAM, at(19, "17:00:00"), "[status-reviewed]");
  timeline(verdictReview, SAM, at(19, "17:00:01"), "[status-reviewed]Ship it.");

  // outdatedReview: a comment on a line the final revision rewrote.
  const GARAGE = "/main/RAC-890_garage-setup";
  server.addBranch({
    base: redline.id, comment: "RAC-890 garage setup", date: at(19, "09:50:00"), id: 16, name: GARAGE, owner: OMAR,
  });
  const camber = server.checkin(GARAGE, info(OMAR, at(19, "10:00:00"), "RAC-890 garage: camber and toe per axle"));
  camber.change(setupSheet, lines => rewrite(lines, 11, 5, camber.id));
  const preset = server.checkin(GARAGE, info(OMAR, at(19, "15:00:00"),
    "RAC-890 garage: read camber from the car preset"));
  preset.change(setupSheet, lines => rewrite(lines, 12, 3, preset.id));

  const outdatedReview = 306;
  const outdatedVerdict = "Looks fine apart from the camber note.";
  review({
    assignee: "", date: at(19, "10:30:00"), id: outdatedReview, owner: OMAR, status: "Under review", target: 16,
    targetType: "Branch", title: "Garage setup sheet",
  });
  timeline(outdatedReview, OMAR, at(19, "10:31:00"), `[requested-review-from]${PRIYA}`);
  timeline(outdatedReview, OMAR, at(19, "10:32:00"), `[requested-review-from]${SAM}`);
  server.addComment(outdatedReview, SAM, at(19, "11:00:00"), "Negative camber this large will cook the inner shoulder.",
    { location: 13, revision: server.revisionAt(setupSheet, camber.id), type: "change" });
  timeline(outdatedReview, PRIYA, at(19, "12:00:00"), `[status-reviewed]${outdatedVerdict}`);

  // A branch review whose branch was deleted: Find Review… can only say "branch".
  const GHOST = "/main/RAC-899_ghost-car";
  server.addBranch({
    base: countdown.id, comment: "RAC-899 ghost car", date: at(10, "08:50:00"), deleted: true, id: 17, name: GHOST,
    owner: PRIYA,
  });
  const deletedReview = 307;
  review({
    assignee: "", date: at(10, "09:00:00"), id: deletedReview, owner: PRIYA, status: "Under review", target: 17,
    targetType: "Branch", title: "Ghost car replay",
  });

  // Rework, a re-request, then Reviewed.
  const BRAKES = "/main/RAC-895_brake-assist";
  server.addBranch({
    base: redline.id, comment: "RAC-895 brake assist", date: at(19, "10:50:00"), id: 18, name: BRAKES, owner: LENA,
  });
  const soften = server.checkin(BRAKES, info(LENA, at(19, "11:00:00"), "RAC-895 brake assist: soften the ABS pulse"));
  soften.change(brakeAssist, lines => rewrite(lines, 7, 4, soften.id));
  const split = server.checkin(BRAKES, info(LENA, at(20, "10:00:00"),
    "RAC-895 brake assist: split the ABS change from the pedal curve"));
  split.change(brakeAssist, lines => rewrite(lines, 7, 2, split.id));
  const reworkReview = 308;
  review({
    assignee: "", date: at(19, "11:30:00"), id: reworkReview, owner: LENA, status: "Reviewed", target: 18,
    targetType: "Branch", title: "Brake assist tuning",
  });
  timeline(reworkReview, LENA, at(19, "11:31:00"), `[requested-review-from]${SAM}`);
  server.addComment(reworkReview, SAM, at(19, "16:00:00"), "Split the ABS change from the pedal curve.",
    { applied: split.id, location: 8, revision: server.revisionAt(brakeAssist, soften.id), type: "change" });
  timeline(reworkReview, SAM, at(19, "16:01:00"), "[status-rework-required]Two changes in one checkin.");
  timeline(reworkReview, LENA, at(20, "10:30:00"), `[re-requested-review-from]${SAM}`);
  timeline(reworkReview, SAM, at(20, "14:00:00"), "[status-reviewed]Thanks, all good now.");

  // The queue: reviews that ask for the cm user in every way there is, and the cm user's own.
  const queueBranch = (id: number, name: string) => {
    server.addBranch({ base: redline.id, comment: name, date: at(21, "08:00:00"), id, name, owner: SAM });
    return name;
  };
  const queued = (id: number, row: Omit<ISyntheticReview, "id" | "target" | "targetType" | "title">, name: string) =>
    review({
      ...row, id, target: id - 289, targetType: "Branch", title: `Review of branch ${queueBranch(id - 289, name)}`,
    });
  queued(310, { assignee: ME, date: at(21, "09:00:00"), owner: PRIYA, status: "Under review" }, "/main/RAC-901_drs");
  timeline(310, PRIYA, at(21, "09:01:00"), `[requested-review-from]${ME}`);
  queued(311, { assignee: "", date: at(21, "10:00:00"), owner: OMAR, status: "Under review" }, "/main/RAC-902_fuel");
  timeline(311, OMAR, at(21, "10:01:00"), `[requested-review-from-${ME}]`);
  queued(312, { assignee: "", date: at(21, "11:00:00"), owner: SAM, status: "Under review" }, "/main/RAC-903_kerbs");
  timeline(312, SAM, at(21, "11:01:00"), `[requested-review-from]${ME}`);
  timeline(312, SAM, at(21, "11:05:00"), `[removed-requested-review-from]${ME}`);
  queued(313, { assignee: ME, date: at(21, "12:00:00"), owner: NOOR, status: "Rework required" },
    "/main/RAC-904_wet-tyres");
  queued(314, { assignee: ME, date: at(21, "13:00:00"), owner: LENA, status: "Reviewed" }, "/main/RAC-905_ghost-ui");
  queued(315, { assignee: ME, date: at(21, "14:00:00"), owner: ME, status: "Under review" },
    "/main/RAC-906_replay-camera");
  queued(316, { assignee: PRIYA, date: at(21, "15:00:00"), owner: ME, status: "Rework required" },
    "/main/RAC-907_pit-crew-anim");
  timeline(316, ME, at(21, "15:01:00"), `[requested-review-from]${PRIYA}`);
  timeline(316, PRIYA, at(21, "16:00:00"), "[status-rework-required]Please add the pit crew idle loop.");
  queued(317, { assignee: "", date: at(21, "16:00:00"), owner: ME, status: "Reviewed" }, "/main/RAC-908_tyre-temps");
  queued(318, { assignee: "", date: at(21, "17:00:00"), owner: PRIYA, status: "Reviewed" }, "/main/RAC-909_safety-car");
  timeline(318, PRIYA, at(21, "17:01:00"), `[requested-review-from]${ME}`);

  // More than two pages of reviews, by formula: anyone's but the cm user's, a third of them Reviewed.
  for (let index = 0; index < 120; index++) {
    const id = 400 + index;
    const name = queueBranch(600 + index, `/main/RAC-${5000 + index}_backlog`);
    review({
      assignee: OTHERS[(index + 2) % OTHERS.length],
      date: shifted(at(13, "20:00:00"), -index * 4 * 60),
      id,
      owner: OTHERS[index % OTHERS.length],
      status: index % 3 === 2 ? "Reviewed" : index % 7 === 3 ? "Rework required" : "Under review",
      target: 600 + index,
      targetType: "Branch",
      title: `Review of branch ${name}`,
    });
  }

  return {
    branchReview: { branch: LAP_TIMER, id: branchReview },
    changesetReview: { changeset: crossfade.id, id: changesetReview },
    deletedReview: { branchId: 17, id: deletedReview },
    hiddenReview: { branchId: 13, id: hiddenReview },
    namedHiddenReview: { branch: START_LIGHTS, id: 302 },
    outdatedReview: { id: outdatedReview, verdictText: outdatedVerdict },
    overviewReviews: [
      { id: changesetReview, rework: false, waitingOn: [LENA] },
      // The assignee nobody requested waits first, then the requested reviewers by request date.
      { id: branchReview, rework: false, waitingOn: [ ME, PRIYA, NOOR, LENA ] },
      { id: hiddenReview, rework: false, waitingOn: [ PRIYA, SAM ] },
      { id: verdictReview, rework: false, waitingOn: [] },
      { id: reworkReview, rework: false, waitingOn: [] },
      { id: 316, rework: true, waitingOn: [] },
    ],
    server,
    verdictReview: { generalThread, id: verdictReview, replyText, replyToVerdict, verdictText, verdictThread },
  };
}

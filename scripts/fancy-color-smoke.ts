import {
  FANCY_HUES,
  FANCY_INTENSITIES,
  isFancyIntensity,
  parseFancyColor,
  stoneColorLabel
} from "../src/domain";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The lists are ordered the way the client asked for them (KAN-55). Sorting them
 * would look harmless in a diff and be wrong on every picker, so pin the order.
 */
function orderTests(): void {
  console.log("\nGrade lists");
  check(
    "hues stay in trade order",
    FANCY_HUES.join("|") === "Yellow|Orange|Pink|Blue|Green|Brown|Grey|Red|White",
    FANCY_HUES.join("|")
  );
  check(
    "intensities run strongest to faintest",
    FANCY_INTENSITIES.join("|") ===
      "Fancy Deep|Fancy Dark|Fancy Vivid|Fancy Intense|Fancy|Fancy Light|Light|Very Light",
    FANCY_INTENSITIES.join("|")
  );
  check("Fancy is itself an intensity", isFancyIntensity("fancy"));
  check("a hue is not an intensity", !isFancyIntensity("Yellow"));
}

function parseTests(): void {
  console.log("\nSplitting a written colour");
  const cases: [string, string | null, string | null, string | null][] = [
    // written              white   hue            intensity
    ["Fancy Vivid Yellow", null, "Yellow", "Fancy Vivid"],
    ["fancy vivid yellow", null, "Yellow", "Fancy Vivid"],
    ["Fancy Yellow", null, "Yellow", "Fancy"],
    ["Fancy Light Pink", null, "Pink", "Fancy Light"],
    ["Very Light Blue", null, "Blue", "Very Light"],
    ["Light Yellow", null, "Yellow", "Light"],
    ["  Fancy   Intense  Pink ", null, "Pink", "Fancy Intense"],
    ["Yellow", null, "Yellow", null],
    // A white grade must never be reclassified as a colour.
    ["G", "G", null, null],
    ["Pigeon Blood", "Pigeon Blood", null, null],
    ["", null, null, null],
    // An unlisted modifier keeps its text rather than being dropped.
    ["Fancy Yellow-Green", null, "Yellow-Green", "Fancy"]
  ];
  for (const [raw, color, fancyColor, fancyIntensity] of cases) {
    const got = parseFancyColor(raw);
    check(
      `${JSON.stringify(raw)} splits correctly`,
      got.color === color && got.fancyColor === fancyColor && got.fancyIntensity === fancyIntensity,
      JSON.stringify(got)
    );
  }

  console.log("\nLonger intensities win over shorter ones");
  check(
    '"Fancy Light" beats "Fancy"',
    parseFancyColor("Fancy Light Pink").fancyIntensity === "Fancy Light"
  );
  check(
    '"Fancy Deep" beats "Fancy"',
    parseFancyColor("Fancy Deep Brown").fancyIntensity === "Fancy Deep"
  );
}

function labelTests(): void {
  console.log("\nHow a colour reads back");
  check(
    "hue and intensity join up",
    stoneColorLabel({ fancyColor: "Yellow", fancyIntensity: "Fancy Vivid" }) === "Fancy Vivid Yellow"
  );
  check(
    "a bare hue does not gain a prefix",
    stoneColorLabel({ fancyColor: "Pink", fancyIntensity: null }) === "Pink"
  );
  check("a white grade passes through", stoneColorLabel({ color: "G" }) === "G");
  check("the Diamond table's colorWhite works too", stoneColorLabel({ colorWhite: "H" }) === "H");
  check(
    "a fancy grade wins over a stale white one",
    stoneColorLabel({ color: "M", fancyColor: "Blue", fancyIntensity: "Fancy" }) === "Fancy Blue"
  );
  check("an ungraded stone reads as nothing", stoneColorLabel({}) === null);

  console.log("\nEvery grade round-trips");
  for (const hue of FANCY_HUES) {
    for (const intensity of FANCY_INTENSITIES) {
      const written = `${intensity} ${hue}`;
      const back = stoneColorLabel(parseFancyColor(written));
      if (back !== written) {
        check(`${written} survives a round trip`, false, String(back));
        return;
      }
    }
  }
  check(
    `all ${FANCY_HUES.length * FANCY_INTENSITIES.length} grades survive a round trip`,
    true
  );
}

orderTests();
parseTests();
labelTests();

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;

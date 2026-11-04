import { describe, expect, it } from "vitest";
import { findCreditLines, isLeadingHeading, stripWatermarks, WATERMARK_BRANDS } from "./clean";

// Every watermark below is verbatim from a live chapter: novelbuddy.me
// (Shadow's Oath, Martial Peak, Overgeared, …) or novelarchive.st. See
// extensions/novelbuddy/README.md and extensions/novelarchive/README.md.

describe("stripWatermarks — whole watermark lines", () => {
  it("drops every watermark line seen live", () => {
    for (const line of [
      "Foll𝑜w current novℯls on ƒrēewebnoѵёl.cσm.",
      "Updat𝓮d fr𝙤m ƒгeeweɓn૦vel.com.",
      "The 𝘮ost uptodat𝑒 novels are pub𝙡ished on freeweɓnovēl.coɱ.",
      "Visit frёewebnoѵel.ƈo๓ for the b𝘦st novel reading experience.",
      "The 𝘮ost uptodat𝑒 novels are pub𝙡ished on fre(e)webno(v)el.𝒸𝑜𝘮",
      "Read the latest chapters at freewebnovel.com",
      "Follow curr𝒆nt nov𝒆ls on fɾeeweɓnѳveɭ.com.",
      "This chapter is updat𝙚d by f(r)eew𝒆bn(o)vel.com",
      "New novel 𝓬hapters are published on freёwebnoѵel.com.",
      "Read lat𝙚st chapters at fɾeewebnoveℓ.co๓ Only.",
      "𝚏𝕣𝕖𝚎𝚠𝚎𝚋𝚗𝐨𝐯𝕖𝕝.𝕔𝐨𝕞",
      "# Nоvеlight #",
      "Biquge www.novelbuddy.com, update the latest chapter of Master Dan Dao as soon as possible!",
      "Table of Contents URL: https://1stkissnovel.org/novel/children-of-the-holy-emperor/",
    ]) {
      expect(stripWatermarks(line), line).toBe("");
    }
  });

  it("catches what each source's own cleaner used to miss", () => {
    // Look-alikes outside novelarchive's confusables table (г ૦ σ) — the
    // wildcard fold covers them. That cleaner kept the first whole and left
    // ".cσm." of the second.
    expect(stripWatermarks("Updat𝓮d fr𝙤m ƒгeeweɓn૦vel.com.")).toBe("");
    expect(stripWatermarks("Their eyes met. Foll𝑜w current novℯls on ƒrēewebnoѵёl.cσm.")).toBe("Their eyes met.");
    // A digit swap, and a decorated name with no domain — novelbuddy's
    // cleaner wanted a TLD and plain letters, and kept both.
    expect(stripWatermarks("ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ Nove1Fire.net")).toBe("");
    expect(stripWatermarks("❖ Nоvеl𝚒ght ❖")).toBe("");
  });

  it("knows every name it lists, as a domain and disguised", () => {
    for (const name of WATERMARK_BRANDS) {
      // Plain ASCII: this also proves the fast path's prefilter sees it.
      expect(stripWatermarks(`Read more at ${name}.com`), name).toBe("");
      const disguised = name.replace("o", "о").replace("e", "е"); // Cyrillic
      expect(stripWatermarks(`He ran. ❖ ${disguised} ❖ He fell.`), name).toBe("He ran. He fell.");
    }
  });
});

describe("stripWatermarks — inside story text", () => {
  it("cuts the watermark sentence and keeps the story sentences around it", () => {
    expect(stripWatermarks('"Go." Visit frёewebnoѵel.ƈo๓ for the b𝘦st novel reading experience. He went.')).toBe(
      '"Go." He went.',
    );
    expect(
      stripWatermarks(
        "|Additional Boon: Your Way of Mana has been confirmed to completely supersede all Light-based concepts.| ɪꜰ ʏᴏᴜ ᴡᴀɴᴛ ᴛᴏ ʀᴇᴀᴅ ᴍᴏʀᴇ ᴄʜᴀᴘᴛᴇʀs, ᴘʟᴇᴀsᴇ ᴠɪsɪᴛ Nove1Fire.net",
      ),
    ).toBe("|Additional Boon: Your Way of Mana has been confirmed to completely supersede all Light-based concepts.|");
  });

  it("cuts only the domain when it stands as a sentence of its own, glued or not", () => {
    expect(stripWatermarks("Not until today at least.𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖")).toBe("Not until today at least.");
    expect(stripWatermarks("𝕗𝗿𝕖𝐞𝐰𝗲𝕓𝐧𝕠𝕧𝗲𝐥.𝚌𝐨𝚖He went.")).toBe("He went.");
    expect(stripWatermarks('"Black belt?" 𝐛𝐞𝗱𝗻𝐨𝐯𝗲𝗹.𝐜𝐨𝐦')).toBe('"Black belt?"');
    expect(stripWatermarks('auzw.com "Ha." With a grin, Xie Chen was still a little relieved.')).toBe(
      '"Ha." With a grin, Xie Chen was still a little relieved.',
    );
    // …but one that carries on in the same breath takes its sentence along.
    expect(stripWatermarks("freewebnovel.com, the fastest updates around! He ran.")).toBe("He ran.");
  });

  it("cuts a decorated or disguised name with its lead-in and aside, mid-sentence", () => {
    expect(stripWatermarks("The killing intent emanating °• N 𝑜 v 𝑒 l i g h t •° from them was intense.")).toBe(
      "The killing intent emanating from them was intense.",
    );
    expect(stripWatermarks("When Koi got ➤ NоvеⅠight ➤ (Read more on our source) home, he showered.")).toBe(
      "When Koi got home, he showered.",
    );
    expect(stripWatermarks("their ◈ Nоvеlіgһт ◈ (Continue reading) children.")).toBe("their children.");
    expect(stripWatermarks("Ryo ~Nоvеl𝕚ght~ showed the ‘Holy Seal’.")).toBe("Ryo showed the ‘Holy Seal’.");
    expect(
      stripWatermarks(
        '"...I ❖ Nоvеl𝚒ght ❖ (Exclusive on Nоvеl𝚒ght) informed the General at the banquet. Told him that you had a purpose,',
      ),
    ).toBe('"...I informed the General at the banquet. Told him that you had a purpose,');
    expect(stripWatermarks("He said ❖ freewebnovel.com ❖ nothing.")).toBe("He said nothing.");
  });

  it("takes a short bracket group holding a watermark with it", () => {
    expect(stripWatermarks("The [Liancheng www.wsx5.cn] branch of the True Demon Gate Dragon City.")).toBe(
      "The branch of the True Demon Gate Dragon City.",
    );
  });
});

describe("stripWatermarks — leaves story text alone", () => {
  it("keeps plain mentions of web novels and of the sites themselves", () => {
    for (const line of [
      "He spent the night reading a free web novel.",
      "Her novel, completed at last, was the best thing she had written.",
      "The café served crème brûlée to the novelist.",
      "“Novel bin? Throw it in the novel bin,” she joked.",
      "He opened the novel bin and read on.",
      "That's it. The Second Coming of Gluttony is officially over after about a year on NovelFire. This marks the third.",
      "https://en.m.wikipedia.org/wiki/Dano_(festival)",
      "“Tie Zhu, you have great talent! When you are successful in the future, don’t forget to come back and visit.”",
      "|Status: Bound| ~ Level 4 ~",
      "He loved the light-novel world. Then he left.",
      "~a novel full of twists~",
    ]) {
      expect(stripWatermarks(line), line).toBe(line);
    }
  });

  it("never reads CJK text as wildcard letters", () => {
    for (const line of [
      "'Foolish Old Man Moves Mountains (愚公移山).’",
      "Heaven and Earth, read 天地 (tiāndì) aloud.",
    ]) {
      expect(stripWatermarks(line), line).toBe(line);
    }
  });
});

describe("findCreditLines", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}.`);

  it("finds bracketed credits anywhere, bare ones only near a chapter's edges", () => {
    const chapter = ["Translator: Night", ...lines(12), "Editor: Gun", "[Editor - Gun]"];
    chapter.splice(7, 0, "Author: Unknown", "[Translator - Night]");
    expect([...findCreditLines(chapter)].sort((a, b) => a - b).map((i) => chapter[i])).toEqual([
      "Translator: Night",
      "[Translator - Night]",
      "Editor: Gun",
      "[Editor - Gun]",
    ]);
  });

  it("takes a bare label's name line with it, and follows a block of credits past the edge", () => {
    const chapter = [
      "Chapter 1: The Genetic Exam",
      "Translator:",
      "Nyoi-Bo Studio",
      "Editor:",
      "Nyoi-Bo Studio",
      "Proofread By:",
      "Archbishop#750",
      ...lines(10),
    ];
    expect([...findCreditLines(chapter)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads every role and both separators", () => {
    for (const credit of [
      "Translator: AtlasStudios Editor: AtlasStudios",
      "Translated by: Henyee Translations",
      "Translation: Willia",
      "Editor: echo",
      "Edited by: Gun",
      "Proofreader: Gun",
      "Proofreaded by: Gun",
      "Author: Silavin",
      "Translator - Night",
      "TL: Hanguk",
      "TLC: Night",
      "ED: Gun",
      "PR: Gun",
      "[TL - Night]",
    ]) {
      expect(findCreditLines([credit, ...lines(10)]), credit).toEqual(new Set([0]));
    }
  });

  it("leaves speaker lines and narration that only look like credits", () => {
    for (const line of [
      "Ed: [Hey, wait!]",
      "Ed - he never came back.",
      "The editor: a tired man who never slept.",
      "Translator's Comments",
      "Author: Who are you?",
    ]) {
      expect(findCreditLines([line, ...lines(10)]), line).toEqual(new Set());
    }
  });
});

describe("isLeadingHeading", () => {
  it("recognises a numbered heading, and the chapter's own title in any punctuation", () => {
    expect(isLeadingHeading("Chapter 1 - 1")).toBe(true);
    expect(isLeadingHeading("Chapter 4566: One Too Many (Part 2)")).toBe(true);
    expect(isLeadingHeading("Chapter 6081, Disciplinary Hall", { title: "Chapter 6081: Disciplinary Hall" })).toBe(
      true,
    );
    expect(isLeadingHeading("Prologue", { title: "prologue" })).toBe(true);
  });

  it("leaves other first lines alone", () => {
    expect(isLeadingHeading("Chapters were never his strength.")).toBe(false);
    expect(isLeadingHeading("Prologue")).toBe(false);
    expect(isLeadingHeading("Prologue", { title: "Chapter 1: Prologue" })).toBe(false);
  });

  it("with numbered: false, only the title counts", () => {
    expect(isLeadingHeading("Chapter 3: Rain", { numbered: false })).toBe(false);
    expect(isLeadingHeading("Chapter 3 - Rain!", { title: "chapter 3: rain", numbered: false })).toBe(true);
  });
});

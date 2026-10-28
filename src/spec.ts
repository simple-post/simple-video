import { z } from "zod";
import {
  SoundtrackSchema,
  checkSoundtrack,
  AudioLufsSchema,
} from "./soundtrack.js";

const text = z.string().trim().min(1).max(300);
const captionText = z.string().trim().max(300);
const shot = z
  .object({
    prompt: z.string().trim().min(10).max(4000),
    caption: captionText,
    duration: z.number().min(0.5).max(15),
    captionPosition: z.enum(["top", "bottom"]).optional(),
    referencePrevious: z.boolean().optional(),
    captionStyle: z.literal("confession").optional(),
  })
  .strict();
const common = {
  version: z.literal(1),
  name: text,
  look: z.string().trim().min(10).max(1500),
  soundtrack: SoundtrackSchema.optional(),
  audioLufs: AudioLufsSchema.optional(),
  image: z
    .object({
      files: z.record(z.string(), z.string().min(1)).optional(),
      model: z.string().min(1).default("gpt-image-2.5-flare"),
      quality: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .strict(),
  video: z
    .object({
      width: z.number().int().min(180).max(2160).multipleOf(2).default(1080),
      height: z.number().int().min(320).max(3840).multipleOf(2).default(1920),
      fps: z.number().int().min(24).max(60).default(30),
      motion: z.enum(["parallax", "zoom", "static"]).default("parallax"),
      parallaxStrength: z.number().min(0.01).max(0.07).optional(),
      parallaxFit: z.enum(["cover", "contain"]).optional(),
      parallaxPath: z.enum(["pan", "diagonal", "orbit"]).optional(),
      parallaxEngine: z.enum(["cpu", "depthflow"]).default("depthflow"),
      parallaxIntensity: z.number().min(0.01).max(0.5).default(0.105),
      alternateDirections: z.boolean().optional(),
      audio: z
        .enum(["synth", "ambient", "tension", "silent"])
        .default("silent"),
    })
    .strict(),
  budget: z
    .object({
      maxRequests: z.number().int().min(1).max(100),
      maxEstimatedUsd: z.number().positive(),
      estimatePerImageUsd: z.number().positive().default(0.25),
    })
    .strict(),
};
export const SpecSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...common,
        type: z.literal("loop"),
        prompt: z.string().trim().min(10).max(4000),
        caption: captionText,
        duration: z.number().min(2).max(30).default(12),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("battle"),
        hero: text,
        heroCount: z.number().int().min(1).max(6).optional(),
        classicBattle: z.boolean().optional(),
        winnerPattern: z.enum(["final-flip", "custom"]).optional(),
        opponentLook: z.string().trim().min(10).max(1500).optional(),
        heroPrompt: z.string().trim().min(10).max(4000).optional(),
        opponent: text,
        environment: text,
        rounds: z
          .array(
            z
              .object({
                count: z.number().int().min(1).max(20),
                winner: z.enum(["hero", "opponent"]),
                opponentPrompt: z.string().trim().min(10).max(4000).optional(),
                revealPrompt: z.string().trim().min(10).max(4000).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        compareDuration: z.number().min(0.5).max(5).default(1.5),
        revealDuration: z.number().min(0.5).max(5).default(1.5),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("story"),
        character: text,
        shots: z.array(shot).min(2).max(12),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("challenge"),
        question: text,
        shots: z.array(shot).min(2).max(12),
      })
      .strict(),
  ])
  .superRefine((s, ctx) => {
    if (s.type === "battle" && s.winnerPattern === "final-flip") {
      const first = s.rounds[0]!.winner;
      if (
        s.rounds.length < 2 ||
        s.rounds.slice(0, -1).some((r) => r.winner !== first) ||
        s.rounds.at(-1)!.winner === first
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Final-flip battles must keep the same winner until only the last round reverses it",
          path: ["rounds"],
        });
      if (s.rounds.some((r, i) => i > 0 && r.count <= s.rounds[i - 1]!.count))
        ctx.addIssue({
          code: "custom",
          message: "Final-flip battles require increasing challenger counts",
          path: ["rounds"],
        });
    }
    if (
      s.video.parallaxEngine === "depthflow" &&
      (s.video.parallaxPath === "orbit" ||
        (s.type === "loop" && !s.video.parallaxPath))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "DepthFlow supports non-looping pan and diagonal shots. Use the CPU renderer for closed orbits.",
        path: ["video", "parallaxPath"],
      });
    if (s.soundtrack) {
      const duration =
        s.type === "loop"
          ? s.duration
          : s.type === "battle"
            ? s.rounds.length * (s.compareDuration + s.revealDuration)
            : s.shots.reduce((sum, shot) => sum + shot.duration, 0);
      try {
        checkSoundtrack(s.soundtrack, duration);
      } catch (e) {
        ctx.addIssue({
          code: "custom",
          message: String((e as Error).message),
          path: ["soundtrack"],
        });
      }
    }
    if (Math.abs(s.video.width / s.video.height - 9 / 16) > 0.001)
      ctx.addIssue({
        code: "custom",
        message: "Output must be 9:16",
        path: ["video"],
      });
    if (s.name.includes("\n"))
      ctx.addIssue({
        code: "custom",
        message: "Name must be one line",
        path: ["name"],
      });
    const durations =
      s.type === "loop"
        ? [s.duration]
        : s.type === "battle"
          ? [s.compareDuration, s.revealDuration]
          : s.shots.map((shot) => shot.duration);
    if (
      durations.some(
        (d) =>
          Math.abs(d * s.video.fps - Math.round(d * s.video.fps)) > 0.00001,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Durations must be an exact number of output frames",
        path: ["video", "fps"],
      });
  });
export type Spec = z.infer<typeof SpecSchema>;
export type AssetPlan = {
  id: string;
  prompt: string;
  referenceAsset?: string;
  size: "1024x1024" | "1024x1536";
};
export type Scene = {
  id: string;
  assets: string[];
  layout: "split" | "full";
  caption: string;
  duration: number;
  labels?: string[];
  captionPosition?: "top" | "bottom";
  captionStyle?: "classic-count" | "confession";
  panDirection?: 1 | -1;
  zoomIntro?: { duration: number; factor: number };
};
export type Plan = {
  name: string;
  type: Spec["type"];
  assets: AssetPlan[];
  scenes: Scene[];
  duration: number;
  caption: string;
};

const visualRules =
  "Cinematic photography with clear foreground, middle ground and background for depth-based animation. Consistent subjects and lighting across images. No text, logos or watermarks. Clear composition with room for captions.";
export function planExperiment(spec: Spec): Plan {
  const assets: AssetPlan[] = [];
  const scenes: Scene[] = [];
  const add = (
    id: string,
    prompt: string,
    size: AssetPlan["size"],
    look = spec.look,
  ) => {
    assets.push({
      id,
      prompt: `${visualRules}\n${look}\n${prompt}`,
      size,
    });
    return id;
  };
  if (spec.type === "loop") {
    const id = add("loop", spec.prompt, "1024x1536");
    scenes.push({
      id,
      assets: [id],
      layout: "full",
      caption: spec.caption,
      duration: spec.duration,
    });
  } else if (spec.type === "battle") {
    const heroCount = spec.heroCount ?? 1;
    const hero = add(
      "hero",
      spec.heroPrompt ??
        (spec.classicBattle || spec.heroCount !== undefined
          ? `Exactly ${heroCount} ${spec.hero}, whole body, facing camera, imposing battle stance. ${spec.environment}. Every creature separately visible with space between silhouettes, no other animals.`
          : `Exactly ONE ${spec.hero}, whole body, facing camera, imposing battle stance. ${spec.environment}. Creature fills the frame, no other animals.`),
      "1024x1024",
    );
    spec.rounds.forEach((round, i) => {
      const other = add(
        `opponents-${i}`,
        round.opponentPrompt ??
          `Exactly ${round.count} ${spec.opponent}, every animal separately visible, facing camera in a confrontational stance. ${spec.environment}. No other animals.`,
        "1024x1024",
        spec.opponentLook,
      );
      const result = add(
        `reveal-${i}`,
        round.revealPrompt ??
          (spec.classicBattle || spec.heroCount !== undefined
            ? `Outcome of a fictional matchup: exactly ${heroCount} ${spec.hero} versus exactly ${round.count} ${spec.opponent}. Winner: ${round.winner === "hero" ? spec.hero : spec.opponent}. Winning side stands tall in foreground; losing side retreats in background. All animals alive, no injury. Every animal individually visible and countable, no hidden extra animals. ${spec.environment}. Vertical full-body cinematic composition.`
            : `Outcome of a fictional matchup: ONE ${spec.hero} versus ${round.count} ${spec.opponent}. Winner: ${round.winner === "hero" ? spec.hero : spec.opponent}. Winning side stands tall in foreground; losing side retreats in background. All animals alive, no injury. ${spec.environment}. Vertical full-body cinematic composition.`),
        "1024x1536",
      );
      scenes.push({
        id: `compare-${i}`,
        assets: [hero, other],
        layout: "split",
        caption: `${heroCount} vs ${round.count}`,
        ...(spec.classicBattle
          ? {
              captionStyle: "classic-count" as const,
              panDirection: (i % 2 ? 1 : -1) as 1 | -1,
              zoomIntro: { duration: 0.1, factor: 5 },
            }
          : { labels: [spec.hero, spec.opponent] }),
        duration: spec.compareDuration,
      });
      scenes.push({
        id: `result-${i}`,
        assets: [result],
        layout: "full",
        caption: spec.classicBattle
          ? ""
          : `${round.winner === "hero" ? spec.hero : spec.opponent} wins`,
        ...(spec.classicBattle
          ? { panDirection: (i % 2 ? 1 : -1) as 1 | -1 }
          : {}),
        duration: spec.revealDuration,
      });
    });
  } else {
    spec.shots.forEach((s, i) => {
      const context =
        spec.type === "story"
          ? `Recurring character: ${spec.character}.`
          : `Challenge: ${spec.question}.`;
      const id = add(`shot-${i}`, `${context}\n${s.prompt}`, "1024x1536");
      if (s.referencePrevious && i > 0)
        assets.at(-1)!.referenceAsset = `shot-${i - 1}`;
      scenes.push({
        id,
        assets: [id],
        layout: "full",
        caption: s.caption,
        duration: s.duration,
        ...(spec.video.alternateDirections
          ? { panDirection: (i % 2 ? -1 : 1) as 1 | -1 }
          : {}),
        ...(s.captionPosition ? { captionPosition: s.captionPosition } : {}),
        ...(s.captionStyle ? { captionStyle: s.captionStyle } : {}),
      });
    });
  }
  return {
    name: spec.name,
    type: spec.type,
    assets,
    scenes,
    duration: scenes.reduce((n, s) => n + s.duration, 0),
    caption: `${spec.name}${spec.image.files ? "" : "\nAI-generated imagery."}${spec.soundtrack?.track ? `\n\n${spec.soundtrack.track.credit}` : ""}`,
  };
}
export function template(type: Spec["type"]): Spec {
  const base = {
    version: 1,
    name: "A little perspective",
    look: "Warm natural photography, layered foreground and distant scenery, consistent lighting.",
    image: { model: "gpt-image-2.5-flare", quality: "medium" },
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      motion: "parallax",
      parallaxEngine: "depthflow",
      parallaxPath: "diagonal",
      parallaxIntensity: 0.105,
      audio: "silent",
    },
    budget: { maxRequests: 3, maxEstimatedUsd: 3, estimatePerImageUsd: 1 },
  };
  if (type === "loop")
    return SpecSchema.parse({
      ...base,
      type,
      prompt:
        "A quiet mountain lake with flowers in the foreground, a wooden boat in the middle and distant peaks.",
      caption: "Take a moment",
      duration: 6,
    });
  if (type === "battle")
    return SpecSchema.parse({
      ...base,
      type,
      name: "The unexpected matchup",
      hero: "a single giant robot",
      opponent: "small delivery robots",
      environment:
        "A playful fictional robotics arena with no damage or injuries",
      winnerPattern: "final-flip",
      classicBattle: true,
      video: { ...base.video, parallaxPath: "pan", parallaxIntensity: 0.15 },
      rounds: [
        { count: 1, winner: "hero" },
        { count: 3, winner: "hero" },
        { count: 8, winner: "opponent" },
      ],
      compareDuration: 1.5,
      revealDuration: 1.5,
      budget: { maxRequests: 7, maxEstimatedUsd: 7, estimatePerImageUsd: 1 },
    });
  const shots = [
    {
      prompt:
        "A small terrier facing a huge muddy puddle, wet leaves in the foreground, garden in the distance.",
      caption: "A small obstacle",
      duration: 3,
    },
    {
      prompt:
        "The same terrier proudly jumping over the garden puddle, with layered flowers and distant trees.",
      caption: "A big decision",
      duration: 3,
      referencePrevious: true,
    },
    {
      prompt:
        "The same muddy terrier sleeping contentedly beside the garden door after the adventure.",
      caption: "Worth it",
      duration: 3,
      referencePrevious: true,
    },
  ];
  return SpecSchema.parse({
    ...base,
    type,
    ...(type === "story"
      ? { character: "A small scruffy terrier with a blue collar" }
      : { question: "Can a small terrier cross a giant puddle?" }),
    shots,
  });
}

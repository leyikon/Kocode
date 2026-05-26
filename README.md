# Kocode / ココーデ

> はじめての vibe coding を、もっとやさしく、もっと人間らしく。

**Kocode** is a warmer, less intimidating coding companion for students and
first-time vibe coders. It is built as a VS Code extension, but its goal is not
to feel like a professional developer tool. Kocode should feel like someone
kind is sitting beside you, helping you turn vague ideas into something that
works.

The product direction is simple:

**De-professionalize coding. Make the editor feel friendly, conversational, and
alive.**

## Product Goal

Most coding tools assume the user already speaks like an engineer. Kocode goes
the other way. It avoids unnecessary technical words, explains unfamiliar ideas
gently, and helps people keep moving even when they only have a rough feeling
like "I want to make this kind of app."

Kocode is for people who want to start creating with AI before they know all
the professional vocabulary.

## Core Experience

| Direction | What It Means |
| --- | --- |
| やさしい会話 | Explain things in warm, simple language instead of dense technical terms. |
| ここちゃん | Build a light anime-style companion character who makes the editor feel less cold. |
| Vibe first | Let users describe feelings, images, and rough ideas before exact requirements. |
| No jargon wall | If a technical word is needed, explain it softly with an example. |
| Human editing | Make code changes feel like a collaborative conversation, not a machine command. |
| Beginner-safe flow | Guide first-time users step by step without making them feel behind. |
| Cost-aware models | Use stronger models only when the task really needs them. |

## Who It Serves

- Students who want to try vibe coding for the first time.
- People who are curious about making apps but do not feel like "programmers" yet.
- Creators who have ideas, characters, stories, designs, or moods they want to turn into software.
- Beginners who feel stressed by professional tools, English jargon, or error messages.
- Japanese users who want a softer, more familiar coding experience.

## Tone Principles

1. Speak like a patient companion, not a senior engineer giving a lecture.
2. Prefer plain words. When jargon is unavoidable, translate it into everyday language.
3. Start from the user's feeling or goal before discussing implementation.
4. Make errors feel solvable, not embarrassing.
5. Let the character voice add warmth without getting in the way of serious work.
6. Treat coding as a creative activity, not only a professional skill.

## Planned MVP

- A friendly Kocode sidebar experience in VS Code.
- A soft Japanese-first conversation style for code creation and debugging.
- A beginner mode that avoids professional vocabulary where possible.
- Gentle error explanations that say what happened and what to try next.
- Character-driven UI moments around the companion role of `ここちゃん`.
- Smart model routing so casual tasks stay affordable and hard tasks still get enough power.

## Status

This repository is the initial Kocode fork and rebranding baseline. Current
work focuses on the VS Code extension under [`apps/vscode`](./apps/vscode).
Internal `cline.*` command IDs, protocol paths, service integrations, and SDK
package names are intentionally retained during the initial migration so the
upstream code remains buildable while Kocode-specific experience work is
developed.

## Development

The extension package lives in `apps/vscode`.

```bash
cd apps/vscode
npm run install:all
npm run compile
```

The fork tracks upstream through the `upstream` Git remote:

```bash
git fetch upstream
```

## Upstream And License

Kocode is derived from [Cline](https://github.com/cline/cline), an open-source
project licensed under the [Apache License 2.0](./LICENSE). Original copyright
and license notices are preserved. Kocode is an independent product direction
and is not represented as an official Cline release.

# Sequence — Frontend Handoff

**For:** the designer rebuilding the interface
**Live app:** `sequence-black.vercel.app`
**Date:** 11 August 2026 · app version 0.3.0

---

> **Status: answered.** The design this brief asked for landed as
> `Claude Designs/sequence pwa design v1/handoff/Sequence-Handoff.md`, and the
> interface described below is now built to it (13 August 2026). That document
> is the reference for how anything should *look*; this one remains the
> reference for what each screen has to *do*.

## What this document is and isn't

This describes **what each screen has to do** — its purpose, what it shows, and
every state it can be in. It does **not** describe how anything should look.

There is no design system here on purpose. Colour, typography, spacing,
components and layout are yours. The existing interface is being replaced; treat
it as a working prototype that proves the flows, not as a reference.

Where a specific number or wording appears below, it's because it's enforced in
code and the interface has to communicate it accurately. Everything else is open.

---

## 0. Design this as an app, not a website

Sequence is a website technically, but creators add it to their phone's home
screen and it opens **full-screen with no browser interface at all** — no
address bar, no tabs, no toolbar. It should be designed as a portrait mobile
app. Designed as a website, it will feel broken.

Four consequences worth having in front of you before you start:

**There is no back button — you own all navigation.**
The single most important item here. In full-screen mode iOS provides no back
affordance whatsoever, and there is no browser chrome to fall back on. **Every
screen that isn't the root needs its own designed way back.** (The current video
page has an "All videos" link at the top for exactly this reason — it isn't
decoration.)

**Navigation should be thumb-reachable.**
The current sidebar is a desktop pattern inherited from the prototype. Bottom
navigation is both the app convention and the reachable one on a phone.

**Respect the safe areas.**
Content must not sit under the notch or the home-indicator bar.

**Portrait only.**
Orientation is locked in the app manifest; the interface never rotates. Design
for one orientation.

### The one caveat

It must still work **opened in a normal browser tab**, because not everyone
installs it and every first-time visitor arrives in Safari. So: design as an app,
but nothing may *depend* on being installed. In practice that means don't place
critical controls where Safari's own toolbar would cover them, and don't hide
anything essential behind installing.

> **One-line brief:** design a portrait mobile app that also survives being
> opened in a browser tab; assume no browser chrome and no system back button.

---

## 1. What Sequence does

A creator uploads raw phone footage of a product. The app analyses it, decides
where to cut, and returns finished vertical videos ready to post to TikTok.

There are two editors:

| Editor | Input | Output |
|---|---|---|
| **Silent cuts** | Several clips of the product | Multiple different edits, **no audio**, with a hook caption burned on. The creator adds their own voiceover in TikTok. |
| **Talking to camera** | One take of the creator speaking | **One** edit. Pauses removed, their audio kept, captions burned on automatically. |

Silent cuts produces 1–20 variations of the same footage so the creator can post
several without re-filming. Talking mode always produces exactly one, because the
audio fixes the order of the cuts.

---

## 2. Who uses it, and the three facts that shape every screen

**Audience:** TikTok Shop UGC creators. They film on a phone, edit on a phone,
and post from a phone. Some do voiceover-style product videos, some talk to
camera. They are not technical and they are not video editors.

Three facts drive most of the design problems:

**1. It's phone-first, not phone-compatible.**
Everything is done on a phone — filming, uploading, reviewing, downloading,
posting. Desktop exists but is the secondary case. Assume one thumb.

**2. A job takes 10–15 minutes.**
This is not a spinner. The creator starts a job, leaves the app, and comes back
later. Any screen that shows progress needs to be genuinely useful to somebody
returning to it cold, and leaving is the expected behaviour, not a failure case.

**3. Uploads are enormous.**
Raw 4K phone footage is roughly **150 MB per clip**, and a job averages
**5 clips**. Uploads can take minutes on mobile data. Upload progress is not a
nicety — without it the app appears frozen, which is exactly what happened
before it was added.

---

## 3. Screen inventory

| Route | Screen | Who sees it |
|---|---|---|
| `/sign-in`, `/sign-up` | Sign in / Sign up | Signed out |
| `/` | Home | Signed in |
| `/jobs` | Your videos | Signed in |
| `/jobs/new` | New video | Signed in |
| `/jobs/[id]` | Video detail | Signed in |
| `/profile` | Profile | Signed in |
| `/status` | Operations dashboard | Owner only — **out of scope**, internal tool |

Sign-in and sign-up are rendered by Clerk (the auth provider). Styling options
there are limited; worth knowing before you plan a bespoke treatment.

---

## 4. Screens in detail

### 4.1 Home — `/`

**Purpose:** get a returning creator to their recent work or into a new job.

**Currently shows:** recent jobs, and a prompt to start a new one.

**Signed-out visitors currently see the app shell with nothing useful.** There is
no marketing page. If a landing page is in scope, this is where it goes.

| State | What's true |
|---|---|
| Loading | Jobs are being fetched |
| Has jobs | Show recent ones, most recent first |
| No jobs | First-time creator — this is the onboarding moment, and it's currently weak |

---

### 4.2 Your videos — `/jobs`

**Purpose:** find a past job and get back to its results.

**Each job card shows:** product name · status · number of variations · video
length · pacing · a thumbnail from the finished video.

| State | What's true |
|---|---|
| Loading | — |
| Empty | No jobs yet |
| In progress | Job is still running; card should read as "working", not "broken" |
| Done | Results are ready |
| Failed | Job failed; a reason exists and should be reachable |

---

### 4.3 New video — `/jobs/new`

The most complex screen, and the one most worth rethinking. It currently asks
for everything on one long page.

**Fields, in current order:**

1. **Product name** — free text. Example placeholder: *"e.g. Streetwear Zip-Up Hoodie"*
2. **What are you making?** — `Silent cuts` or `Talking to camera`
3. **Upload clips** — multi-select video files
4. **How do you want to edit this?** — `Custom` or `Style` *(hidden in talking mode)*
   - **Custom** → a **Pacing** choice: `Slow` / `Medium` / `Fast`
   - **Style** → pick a named style. Some styles ask for extra image uploads
     (a product photo, or up to 4 "fit pics" of people wearing the item)
5. **Video length** — slider, **10–60 seconds**
6. **Sizing info** — on/off. When on, asks **size worn** (e.g. "M"). Height and
   weight come from their profile.
7. **Variations** — slider, **1–20** *(hidden in talking mode; always 1)*
8. **On-screen text** — a live preview plus controls (see 4.3.1)
9. **Submit**

**Talking mode hides steps 4, 7** and the footage warnings, because they don't
apply to one take of somebody speaking.

#### 4.3.1 On-screen text — the caption editor

A **live preview at 9:16**, showing a real frame from a clip the creator just
picked, with the caption text drawn over it exactly as it will appear in the
finished video. It updates instantly.

Controls: **font** (4 choices) · **size** · **position across** · **position
down** · **colour** · reset · save as default.

The creator can also **drag the text directly on the preview**. Two text blocks
can be positioned independently — the hook and the sizing info — and tapping
either selects it.

> This preview must stay 9:16 and must remain large enough to judge text
> placement against a face. It is the one element where the aspect ratio is a
> hard constraint rather than a layout choice.

#### 4.3.2 Messages this screen must be able to show

| Message | When |
|---|---|
| `5 clips ready · 47s` | After files are picked |
| `Skipped 2 clips under 3s — too short to cut from. Record longer takes.` | Short clips were dropped |
| `40s of footage makes about 1 good variation at 30s — 10 needs roughly 165s. Add clips, or drop to 1.` | Not enough footage for the requested variations |
| Per-field validation errors | Invalid input |
| Upload progress | While uploading — **essential**, see §2 |

#### 4.3.3 States

| State | What's true |
|---|---|
| Idle | Filling the form |
| Uploading | Clips going up; progress visible; can't submit |
| Creating | Job being created |
| Error | Something failed; the form keeps what they entered |

---

### 4.4 Video detail — `/jobs/[id]`

**Purpose:** two different jobs depending on when you arrive — *"is it working?"*
while it runs, and *"give me my videos"* when it's done.

**Header shows:** product name · status · length, pacing/style, variation count.

**Progress** runs through six stages, in order:

| Stage | Wording currently shown |
|---|---|
| `pending` | **Queued** — Waiting for a free slot |
| `tagging` | **Tagging clips** |
| `planning` | **Planning cuts** |
| `planned` | **Planned** — Cuts decided, about to render |
| `rendering` | **Rendering** |
| `done` | **Done** — All videos ready to download |

A seventh state, `failed`, can happen at any point and carries a plain-language
reason.

**Results:** one tile per variation. Each shows a **thumbnail**, the **hook
text** written for it, its **duration**, and gives **play** and **download**.
Variations arrive one at a time — the page polls, so tiles fill in progressively
rather than all at once.

There is also a **download-all** action (currently desktop only — worth
reconsidering).

| State | What's true |
|---|---|
| Queued / running | Progress stages; no results yet; tiles may be partially filled |
| Warning | Job succeeded but with a caveat, e.g. videos shorter than requested because footage was thin |
| Done | All variations ready |
| Partial | Some variations succeeded, some failed — **both shown together** |
| Failed | Whole job failed, with a reason |
| Notify prompt | While running, offers to send a notification when finished (see §6) |

> **Partial success is a real, common state.** A job can deliver 8 of 10 videos.
> The design shouldn't force a binary success/failure read.

---

### 4.5 Profile — `/profile`

**Purpose:** the details that get burned into videos, plus personal defaults.

**Fields:** height · weight · who they make content for (`men's` / `women's` /
`any`) · their saved caption look.

Height and weight appear on-screen in the finished videos as sizing info, so
they're product data, not vanity settings.

---

## 5. Rules the interface has to communicate

These are enforced in code. Copy must stay accurate to them.

| Rule | Value | Why it exists |
|---|---|---|
| Minimum clip length | **3 seconds** | Shorter clips can't be cut two different ways, so every variation would be identical. Clips under this are dropped at selection with a message. |
| Video length | **10–60 seconds** | |
| Variations | **1–20** | Talking mode is always 1 |
| Footage needed | length × (1 + 0.5 × (variations − 1)) | 10 videos of 30s needs ~165s of footage. Under this, the creator is told how many variations their footage actually supports. |
| Fit pics | max **4** | More than four on screen is unreadable |
| Videos are silent | Silent-cuts mode only | The creator adds voiceover after. This surprises people and is worth stating clearly. |

---

## 6. Notifications

The app can be added to a phone's home screen and send a push notification when
a job finishes — *"Your 5 videos are ready"*.

Two design implications:

- On iPhone, notifications only work if the app was **added to the home screen**.
  The interface has to explain that step, since the phone won't do it on its own.
- Permission is currently asked **on the job detail page while a render is
  running** — the moment the creator has an obvious reason to want it. Asking
  earlier gets a permanent "no", and the browser never asks again.

---

## 7. Deliberately not specified

Yours entirely:

- Colour, typography, spacing, iconography
- Component library and layout system
- Navigation structure — the *shape* is yours (currently a sidebar: Home /
  Your videos / New video / Profile). The constraint in §0 stands: every screen
  needs a designed way back, because the phone provides none.
- How the new-video form is broken up — one page, steps, or something else
- Empty states, onboarding, and first-run experience
- Whether the job detail page separates "running" and "finished" views

---

## 8. Gaps worth knowing about

Things that don't exist yet and may fall to you:

- **No landing page.** Signed-out visitors see the app shell.
- **No onboarding.** A first-time creator gets an empty list and no guidance on
  what footage to shoot.
- **No delete.** Creators can't remove a job or their footage.
- **Talking mode is new** and has not yet been used on real footage by a real
  creator — treat its screens as least-validated.
- **Sign-up is currently open to anyone** with the link. Invite-gating is planned,
  which may add a screen.

---

## 9. Constraints worth respecting

- **9:16 portrait** everywhere video is shown. The caption preview in particular
  must hold that ratio and stay big enough to judge text over a face.
- **Progressive results.** Variations arrive one at a time over several minutes.
- **Long waits are normal.** 10–15 minutes per job; leaving and returning is the
  expected behaviour.
- **Large uploads.** Minutes-long, on mobile data, with progress that must be
  visible and honest.

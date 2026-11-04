# Hasanify

A Manifest V3 browser extension that autofills job applications — Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS and most home-grown ATS forms — from a profile you keep locally.

## Features

- **One-click autofill** from the toolbar popup, the floating on-page assistant, the right-click menu, or `Alt+Shift+F`.
- **Heuristic field matching**: reads `name`/`id`/`autocomplete`/`aria-*`/placeholder, `<label>`s, nearby text and section context (Education vs. Experience, "Work Experience 2") to classify ~60 field types.
- **Framework-safe injection**: native value setters plus `input`/`change`/`blur` events, real click sequences for radios, checkboxes and custom dropdowns (react-select, Workday listboxes), `DataTransfer` file uploads.
- **Multi-step forms**: a `MutationObserver` fills new steps as they render, and fields wiped by late React hydration are re-filled.
- **On-page assistant**: progress, filled count, a clickable "needs your attention" list, and an Attachments card for resume / cover-letter uploads.
- **Tailored applications**: resume uploads can be *automatic*, *ask me each time* (pick saved or a tailored file from the assistant), or *manual*; cover letters can be left entirely to you.
- **AI profile builder**: copy a prompt into ChatGPT / Claude / Gemini with your resumes and questionnaires; it interviews you about anything missing and returns a profile you paste back and import.
- **Profile dashboard**: personal info, links, experience, education, skills, work authorization, preferences, voluntary EEO answers, documents and custom Q&A — autosaved and validated against a JSON schema.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. The dashboard opens — fill your profile manually or with the **AI profile builder**.

## Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: storage, messaging, fill triggers, badge |
| `content.js` | Field scanning, classification, injection, mutation handling |
| `ui/widget.js` | Floating on-page assistant (closed shadow root) |
| `shared/profile-schema.js` | Profile JSON Schema, defaults, validator, completeness |
| `options/` | Profile dashboard + AI profile builder |
| `popup/` | Toolbar popup |
| `ui/theme.css`, `ui/icons.js`, `icons/` | Shared styles, icons, extension icons |

## Privacy

Your profile and resume are stored only in `chrome.storage.local` on your machine. Hasanify never submits applications — always review before you click submit.

# Learning

A voice tutor for your iPhone. You talk, it talks back. It has 4 courses with full lesson plans:

| Course | Lessons | How it teaches |
|---|---|---|
| Spanish | 73 in 11 units, A1 to C1, with a unit on clinical Spanish | You speak from the first minute. It models a phrase, you repeat, it corrects you and builds from there. |
| Japanese | 63 in 10 units, first sounds through N3, keigo, and Kansai-ben | Same speaking-first method. Kana and romaji appear on screen while you listen. |
| Irish History | 96 in 15 units, Mount Sandel to Brexit | Told as stories in short pieces. You can interrupt with questions at any point, and it quizzes you. |
| Clinical Practice | 75 in 12 units: PCBH, MI, risk, trauma, SUD, ethics, grand rounds | Case challenges. It gives you a vignette, you say what you'd do, it gives you direct feedback and teaches the evidence. |

Every course also has **Free conversation** for practice outside the lesson plan.

When you tap **End lesson**, the tutor writes itself private notes: what you covered, what you got right, and what to go over again. It reads those notes at the start of later lessons so it can review your weak spots. You can read them from the notes icon on each course page.

## What you need

- **An Anthropic API key**, for the tutor itself (Claude). Get one at [console.anthropic.com](https://console.anthropic.com).
- **An OpenAI API key** (recommended). It gives you the natural voice and the speech recognition that handles English, Spanish, and Japanese in the same sentence. Get one at [platform.openai.com](https://platform.openai.com).
- An **ElevenLabs key** if you want the most human-sounding voice. This one's optional.

**No paid voice key? Use the Natural voice.** In Settings, set **Voice engine** to **Natural voice**. It's [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), a free, open-source voice that runs on your phone. It downloads about 90 MB the first time (use Wi-Fi) and speaks English. Spanish and Japanese phrases use the iPhone voices. The tutor may take a second or 2 longer to start talking, because your phone does the work.

With no OpenAI key, the app uses the iPhone's built-in voices and dictation, which are free. For better built-in voices, go to iPhone **Settings › Accessibility › Read & Speak › Voices** (on older iOS, **Spoken Content › Voices**) and download the *Premium* or *Enhanced* English, Spanish, and Japanese voices. Then, in the app's Settings, tap **Refresh voice list** and pick them.

Your keys stay on your phone. The app sends them only to Anthropic, OpenAI, or ElevenLabs. Set a monthly spending limit in each dashboard. My rough estimate for a 30-minute lesson is 50¢ to $1 using Opus 5.5 and the OpenAI voice. Sonnet 5.5 costs less. Check your own usage after a few lessons.

## Put it on your iPhone

The app is a single web page that installs to your home screen. You don't need the App Store or a Mac.

1. **Publish it with GitHub Pages.** In this repository on GitHub, go to **Settings › Pages**. Under *Build and deployment*, choose **Deploy from a branch**. Pick the branch with this code (`main` after it's merged) and the **`/docs`** folder, then click Save. A minute later GitHub shows the address, something like `https://seany420.github.io/Learning/`.
   - On the free GitHub plan, Pages only works for public repositories. If you'd rather keep the repo private, drag the `docs` folder onto [Netlify Drop](https://app.netlify.com/drop) to get an address.
2. **Open that address in Safari** on your iPhone.
3. Tap **Share › Add to Home Screen**. From now on it opens full screen, like an app.
4. Open it, tap the gear, and paste your keys.
5. Pick a course, tap **Start**, then tap the big mic button.

## Using it

- **Hands-free** (on by default): after the tutor finishes talking, it starts listening. When you stop talking for about 1.6 seconds, it sends what you said. If you need more time to think in Spanish or Japanese, turn the pause up in Settings.
- **Tap the mic while the tutor is talking** to cut in. It stops and listens.
- **Mic: auto / English / Español / 日本語** tells the speech recognizer which language you're speaking. Auto works well with OpenAI. With iPhone dictation, pick the language before you speak.
- **Voice 1x** slows the tutor down (0.85x, 0.7x) or speeds it up.
- **Replay** repeats the tutor's last answer. The **keyboard** button lets you type.
- **⋮ › End lesson** saves notes and checks the lesson off. Leaving any other way keeps the conversation, so you can resume it later.
- **Settings › Backup** exports your progress and notes as a file. Do it once in a while, since everything lives on the phone.

## How it's built

Plain HTML, CSS, and JavaScript in `docs/`. There's no build step.

| File | What it does |
|---|---|
| `docs/js/curriculum.js` | Every unit and lesson, each with a one-line description of what it has to cover. Edit this to add or change lessons. |
| `docs/js/prompts.js` | How the tutor teaches each course, and its rules for speaking out loud. |
| `docs/js/tutor.js` | Streams replies from Claude through the Anthropic SDK (bundled in `docs/vendor/anthropic.js`, version 0.131.0). |
| `docs/js/voice.js` | Speech in and out. It splits replies into sentences as they arrive so the tutor starts talking before it finishes writing, and switches voices for Spanish and Japanese. |
| `docs/js/app.js` | Screens, turn-taking, and progress. |
| `docs/js/store.js` | Saves settings, progress, notes, and lesson transcripts on the phone. |

The tutor marks Spanish with `<es>…</es>` and Japanese with `<ja>…</ja>`. Pronunciation guides go in `[[…]]`. The app highlights the tagged phrases, uses the right voice for them, and shows the guides without reading them out loud.

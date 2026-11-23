# Pair two workbenches and ask a question

Two people, each with their own Botbench, can pair their workbenches and send each other questions and answers about a repository both of them work on. Every message that leaves is one its owner approved with Send; every message that arrives is a card for its owner, and runs nothing. The rules are in [ADR 0004](adr/0004-peers-direct-messages.md), and what a message can and cannot do is in the threat model, boundary B16 ([`security/threat-model.md`](security/threat-model.md)).

## What you need

- Two Botbench installations, here called alice and bob, each already working (the README's [Quickstart](../README.md#quickstart)). Each has its own name in Settings → This workbench → Workbench.
- One repository both of you have a copy of, with the same remote: a GitHub repository, or for a try on one Mac, a bare repository on disk that both copies use as `origin`.
- A network path between the two Botbench processes: the same Mac (loopback, the only setup this version has been tested on), or an address on a private network you both use (RFC 1918, RFC 4193, or 100.64.0.0/10 as overlay networks use). Botbench refuses to start with a public address.

What this first version does not do: pair with more than one workbench at a time, send anything but questions and answers, send files or branches, run anything because of a message, or relay messages through any service.

## 1. Switch the listener on, on both sides

In each installation's settings file (`botbench.local.json` in the checkout, or the file `BOTBENCH_CONFIG` names), add a listener address and a port that installation alone uses:

```json
{ "peers": { "listen": { "address": "127.0.0.1", "port": 4790 } } }
```

On one Mac, give bob another port, such as 4791. Start each Botbench again. Settings → Paired workbench then shows Invite and Paste an invite; without the setting it says "Pairing is off" and how to switch it on.

## 2. Invite (alice)

In Settings → Paired workbench, choose the repository and press **Make an invite**. Botbench shows a one-line invite starting `botbench-invite-1.`, "It works once, until 14:32.", Withdraw, and this workbench's fingerprint (five groups of four characters). Press Copy and pass the line to bob yourself, in a message you trust. It is shown only this once.

## 3. Paste and check (bob)

In Settings → Paired workbench, paste the line into Invite, choose your copy of the repository and press **Check the invite**. Botbench shows the inviter's name (alice), alice's fingerprint and the repository. Ask alice to read out the fingerprint her screen shows; if it is the same, press **Confirm**. Bob's screen then reads "Waiting for alice to confirm".

## 4. Compare fingerprints and confirm (alice)

Alice's screen now shows "bob asks to pair", with bob's fingerprint and her own. Ask bob to read out his. If they match, press **Confirm** (or Refuse, which ends it). Both screens then read **Paired**, with each other's name, fingerprint and repository, and four settings: send questions, send answers, take questions, take answers, all On.

## 5. Ask and answer

- Alice writes in "A new question for bob" and presses **Send**. Under the button: "Your question: Sending to bob's workbench." and then, once bob's Botbench has stored it, the conversation shows it as Delivered.
- Bob's header says "1 message with the paired workbench waits for you." On Work, under Needs you, a card reads "alice asks a question about …" with the **Outside text** badge and the question as plain text. Bob chooses **Answer it yourself**, writes the answer and presses Send; or **Give it to Claude Code**, which starts a Manual task in his copy, marked as having read outside text; or **Dismiss**.
- Alice gets a card "bob answered your question about …", and the conversation (Open the conversation, or Settings → Paired workbench → Conversations) shows both messages, each marked as hers or bob's, with its state.

When a task's Claude Code drafts a question to the other workbench, its card "Send this to bob?" shows the exact text and waits for Send, Edit or Don't send. The task itself ends as "Drafted a message" when it changed no file.

## 6. Switch a kind off, or end

Each of the four settings is an On/Off choice that takes effect at once; switching "Take questions from alice" off tells alice's workbench, and her next question reads "Not sent: switched off". **End pairing**, behind "End pairing with alice?", ends it on both sides: neither can send to the other again, and pairing again needs a new invite.

## How this was checked

The browser test `e2e/paired.e2e.ts` runs these steps with two real Botbench processes on one Mac, over loopback, with a bare repository both copies use: invite, paste, both confirms, a question, Answer it yourself, the answer, an agent's draft sent (a recorded real Claude Code session, replayed), a switched-off kind and End pairing. Give it to Claude Code, Edit, Refuse and Withdraw are covered by the API tests, not in the browser. No one has yet run these steps across two Macs.

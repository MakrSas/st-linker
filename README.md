# ST Chat Bias Linker

SillyTavern UI extension that binds bias settings to the currently opened chat and lets each character force boolean preset switches.

## What it does

- Stores the binding in `chatMetadata`, so every chat can have its own bias.
- For Chat Completion, binds the selected Logit Bias preset.
- For Text Completion, binds the current `logit_bias` list from the active preset/settings.
- Automatically reapplies the bound bias when switching chats if enabled.
- Can optionally update the chat binding whenever the current bias changes.
- Adds a character-card section with `Default` / `Always on` / `Always off` overrides for boolean preset settings.
- Stores character overrides inside the card `data.extensions`, so they travel with the character.

## Installation

Copy this folder into one of these SillyTavern locations:

- `data/<user-handle>/extensions/st-chat-bias-linker`
- `public/scripts/extensions/third-party/st-chat-bias-linker`

Then reload SillyTavern and enable **ST Chat Bias Linker** in the extensions manager.

## Usage

1. Open a chat.
2. Select or edit the bias settings you want in SillyTavern.
3. Open Extensions settings.
4. In **Chat Bias Linker**, click **Bind current bias**.

When you return to this chat later, the extension applies the saved bias automatically if **Auto-apply on chat switch** is enabled.

## Character overrides

Open a character card and find **Preset Switch Overrides**.

- `Default` keeps the value from the current SillyTavern preset.
- `Always on` forces a boolean preset switch on for this character.
- `Always off` forces a boolean preset switch off for this character.

These overrides are currently intended for boolean preset options. Non-boolean preset fields still follow the normal SillyTavern preset behavior.

# ST Chat Bias Linker

SillyTavern UI extension that binds bias settings to the currently opened chat and lets each character override prompt toggles from the current Chat Completion preset.

## What it does

- Stores the binding in `chatMetadata`, so every chat can have its own bias.
- For Chat Completion, binds the selected Logit Bias preset.
- For Text Completion, binds the current `logit_bias` list from the active preset/settings.
- Automatically reapplies the bound bias when switching chats if enabled.
- Can optionally update the chat binding whenever the current bias changes.
- Adds a character-card section with `On` / `Default` / `Off` overrides for prompt toggles from the active Chat Completion preset.
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

- The list is pulled from the currently selected Chat Completion preset prompt order.
- `Default` keeps the current preset value for that prompt.
- `On` forces the prompt enabled for this character.
- `Off` forces the prompt disabled for this character.

These overrides currently target Chat Completion prompt toggles, matching the prompt manager list for the active preset.

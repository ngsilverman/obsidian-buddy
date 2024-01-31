import { App, MarkdownRenderer, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import OpenAI from "openai";

// Remember to rename these classes and interfaces!

interface BuddySettings {
	openAIApiKey: string;
}

const DEFAULT_SETTINGS: BuddySettings = {
	openAIApiKey: ''
}

const sanitizeContent = (s: string): string => {
	return s.replace(/^\s+|\s+$/g, "");
};

interface Message {
	role: string;
	content: string;
}

const gptMessages = (s: string): Message[] => {
	const lines = s.split("\n");
	let messages: Message[] = [];
	let role: string | null = null;
	let content: string | null = null;

	const updateMessages = (): Message[] => {
		if (content !== null) {
			const sanitizedContent = sanitizeContent(content);
			if (sanitizedContent) {
				messages.push({ role: role!, content: sanitizedContent });
				role = null;
				content = null;
			}
		}
		return messages;
	};

	while (lines.length > 0) {
		const line = lines.shift()!;

		if (role !== "assistant" && line.match(/^```buddy\s*$/)) {
			updateMessages();
			role = "assistant";
		} else if (role === "assistant" && line.match(/^```\s*$/)) {
			updateMessages();
			role = "user";
		} else if (role === null) {
			role = "user";
			content = line;
		} else {
			content = content ? `${content}\n${line}` : line;
		}
	}

	if (content !== null && role !== null) {
		if (role === "assistant") {
			new Notice('Error: buddy code block has no end');
			throw new Error("buddy code block has no end");
		} else {
			updateMessages();
		}
	}

	return messages;
};

const messageToMd = (m: Message): string => {
	if (m.role === "assistant") {
		return `\n\`\`\`buddy\n${m.content}\n\`\`\``;
	} else {
		return `\n${m.content}`;
	}
};

export default class BuddyPlugin extends Plugin {
	settings: BuddySettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new BuddySettingTab(this.app, this));

		// TODO: Check that an API key has been set.
		const openai = new OpenAI({
			apiKey: this.settings.openAIApiKey,
			dangerouslyAllowBrowser: true,
		});

		this.addCommand({
			id: 'buddy-chat',
			name: 'Let\'s have a chat',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						const messages = gptMessages(markdownView.getViewData());

						const fileName = markdownView.file?.name;
						const folder = markdownView.file?.parent?.path;
						console.log(markdownView.file);
						const systemPrompt =
							`You are a friendly AI assistant integrated inside of an Obsidian Markdown note named "${fileName}" in folder "${folder}".` +
							" User messages constitute the entire document, interspersed with your own responses." +
							" Feel free to use Markdown in your responses or anything that is compatible with Obsidian or Obsidian plugins.";
						messages.unshift({ role: "system", content: systemPrompt });

						console.log(messages)
						openai.chat.completions.create({
							messages: messages,
							model: 'gpt-3.5-turbo',
						}).then((completion) => {
							const message = completion.choices[0].message;
							const messageMd = messageToMd(message);
							console.log(messageMd);

							const editor = markdownView.editor;
							const lastLine = editor.lineCount() - 1;
							const lastCh = editor.getLine(lastLine).length;
							const endPos = { line: lastLine, ch: lastCh };
							console.log(endPos);

							editor.replaceRange("\n" + messageMd, endPos);
						});
					}

					return true;
				}
			}
		});

		this.registerMarkdownCodeBlockProcessor("buddy", (source, el, ctx) => {
			const callout = el.createEl("div", { cls: "callout" });
			const title = callout.createEl("div", { cls: "callout-title" });
			// const icon = title.createEl("div", { cls: "callout-icon" })
			// icon.createEl("svg" …)
			title.createEl("div", { cls: "callout-title-inner", text: "Buddy" });

			const content = callout.createEl("div", { cls: "callout-content" })
			MarkdownRenderer.render(this.app, source, content, ctx.sourcePath, this)
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class BuddySettingTab extends PluginSettingTab {
	plugin: BuddyPlugin;

	constructor(app: App, plugin: BuddyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('OpenAI API key')
			.addText(text => text
				.setValue(this.plugin.settings.openAIApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openAIApiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}

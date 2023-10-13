import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
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
			messages.push({ role: role!, content: sanitizeContent(content) });
			role = null;
			content = null;
		}
		return messages;
	};

	while (lines.length > 0) {
		const line = lines.shift()!;

		if (role !== "assistant" && line.match(/^```buddy\s/)) {
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

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new BuddySettingTab(this.app, this));
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

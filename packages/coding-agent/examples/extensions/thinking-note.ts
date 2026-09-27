import type { ExtensionFactory } from "@zag/zag-coding-agent";
import { Container, Text } from "@zag/zag-tui";

const extension: ExtensionFactory = zag => {
	zag.setLabel("Thinking note");
	zag.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;

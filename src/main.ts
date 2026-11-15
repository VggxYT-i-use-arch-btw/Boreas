import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/conversation.css";
import "./styles/message-activity.css";
import "./styles/composer.css";
import "./styles/research-card.css";
import "./styles/prompt-card.css";
import "./styles/context-sidebar.css";
import "./styles/settings-profile.css";
import "./styles/dialogs.css";
import "./styles/animations.css";
import "./styles/ui-refresh.css";
import "./styles/ui-refresh-chat.css";
import "./styles/ui-refresh-sidebar.css";
import "./styles/ui-refresh-dialogs.css";
import "./styles/ui-refresh-refinements.css";
import "./styles/ui-refresh-streaming.css";
import "./styles/ui-refresh-trace.css";
import "./styles/ui-refresh-product.css";
import "./styles/ui-refresh-navigation.css";
import "./styles/ui-refresh-chat-product.css";
import * as BoreasApi from "./api/client";
import { escapeHtml } from "./utils/escape-html";

const BOREAS_LOGO_URL = `${import.meta.env.BASE_URL}assets/images/boreas.png`;
Object.assign(globalThis, { BoreasApi, BOREAS_LOGO_URL, escHtml: escapeHtml });

async function loadApplication(): Promise<void> {
  await import("./components/onboard");

  const apiSync = await import("./api/sync");
  const runtime = globalThis as typeof globalThis & {
    BACKEND_URL: string;
    BoreasSync: typeof apiSync.BoreasSync;
  };
  runtime.BACKEND_URL = apiSync.BACKEND_URL;
  runtime.BoreasSync = apiSync.BoreasSync;

  // These modules still expose the historical global API consumed across the
  // legacy UI. The Vite transform publishes each module's declarations after
  // evaluation so this ordered chain preserves their initialization contract.
  await import("./legacy/chat-data");
  await import("./legacy/attachments-core");
  await import("./legacy/attachments-images");
  await import("./legacy/sidebar-settings");
  await import("./legacy/sidebar-memory");
  await import("./legacy/sidebar-usage");
  await import("./legacy/composer-input");
  await import("./legacy/streaming-render");
  await import("./legacy/streaming-markup");
  await import("./legacy/streaming-messages");
  await import("./legacy/streaming-cards");
  await import("./legacy/streaming-trace");
  await import("./legacy/streaming-regenerate");
  await import("./legacy/streaming-send");
  await import("./legacy/streaming-resume");
  await import("./components/ui-refresh");
}

void loadApplication().catch((error: unknown) => {
  console.error("Falha ao inicializar Boreas:", error);
});

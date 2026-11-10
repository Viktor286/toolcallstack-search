import { brave } from "./brave.ts";
import { exa } from "./exa.ts";
import { fastcrw } from "./fastcrw.ts";
import { firecrawl } from "./firecrawl.ts";
import { parallel } from "./parallel.ts";
import { tavily } from "./tavily.ts";
import type { Provider } from "./types.ts";
import { you } from "./you.ts";

/** Every provider the gateway knows about. Add a new one here. */
export const providers: Provider[] = [brave, exa, fastcrw, firecrawl, parallel, tavily, you];

export const providersById = new Map(providers.map((provider) => [provider.id, provider]));

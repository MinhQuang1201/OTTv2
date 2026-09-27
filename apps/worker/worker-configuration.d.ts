interface Env {
  Main: DurableObjectNamespace;
  OTT_LOBBY: DurableObjectNamespace;
  OTT_INTERNAL_SECRET: string;
  OTT_TEST_CLOCK_MS?: string;
  OTT_TEST_RECONNECT_GRACE_MS?: string;
  OTT_TEST_CREATOR_ATTACH_TTL_MS?: string;
  OTT_BROWSER_ORIGIN?: string;
}

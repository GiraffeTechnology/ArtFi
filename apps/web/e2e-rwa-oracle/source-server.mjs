// Standalone Node entrypoint; the shared fixture also runs in test runners.
import { startSourceOracleFixture } from "../src/test/rwa-oracle-source-fixture.ts";

const fixture = await startSourceOracleFixture(Number(process.argv[2]));
console.log(`TEST_ONLY source/Oracle fixture listening at ${fixture.origin}`);

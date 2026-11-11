// D6: spawned commands run unsandboxed in tests unless the test opts in.
process.env.SANDBOX_MODE ??= "off";

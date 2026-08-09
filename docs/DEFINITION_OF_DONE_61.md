# BARghCHEE — 61-point Definition of Done

This checklist is the release gate for the requested Persian full-duplex realtime voice experience.

1. Preserve existing repository architecture where sound.
2. Audit current audio path.
3. Audit current websocket path.
4. Audit provider path.
5. Audit security.
6. Remove fake credentials/fallbacks.
7. Keep provider credentials server-side.
8. Define independent connection state.
9. Define independent user speech state.
10. Define independent assistant speech state.
11. Define overlap state.
12. Keep microphone active during assistant output.
13. Keep assistant output independent of microphone state.
14. Support continuous input streaming.
15. Support continuous output streaming.
16. Support natural interruption.
17. Treat overlap as valid conversation state.
18. Add low-latency browser audio processing.
19. Prefer AudioWorklet for capture processing.
20. Avoid blocking the audio render thread.
21. Normalize provider events.
22. Stream user transcript events.
23. Stream assistant transcript events.
24. Preserve timestamps/events.
25. Implement provider abstraction.
26. Make OpenAI Realtime the primary provider.
27. Preserve Gemini as a provider option.
28. Keep product alias `gpt-4o-live` separate from API model IDs.
29. Resolve alias to a valid configured API model.
30. Support provider reconnect.
31. Bound reconnect backoff.
32. Clean up audio resources.
33. Clean up websocket resources.
34. Clean up event listeners/timers.
35. Add tool risk classification.
36. Do not expose arbitrary Node execution to production AI sessions.
37. Require explicit policy for high-risk tools.
38. Separate demo/mock data from real data.
39. Separate simulated calling from real SIP/PSTN calling.
40. Keep SIP transport isolated from browser voice state.
41. Add production logging without secrets.
42. Add diagnostics.
43. Add configuration validation.
44. Fail closed when required credentials are absent.
45. Add unit tests for realtime state.
46. Add unit tests for provider config.
47. Add unit tests for event normalization.
48. Add unit tests for tool policy.
49. Add production readiness checks.
50. Add TypeScript verification.
51. Add build verification.
52. Add CI verification.
53. Expose meaningful connection states in UI.
54. Expose USER SPEAKING state.
55. Expose AI SPEAKING state.
56. Expose OVERLAPPING state.
57. Do not implement Push-to-Talk as the primary interaction.
58. Keep Persian (`fa-IR`) as the default spoken language.
59. Document environment configuration and startup.
60. Document the final practical test procedure.
61. Release only when automated checks pass and the remaining work is the live microphone/provider test.

## Important

Items requiring a real browser, microphone, network and provider credential cannot be truthfully marked complete by source inspection alone. They are complete only after the practical test is executed in a real runtime.

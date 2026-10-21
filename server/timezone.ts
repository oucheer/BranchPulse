// Schedules, reports and email timestamps all rely on the Node process's
// local timezone. Bare `node` deployments inherit the host OS timezone, which
// is often UTC on servers, so pin the process to Beijing time unless the
// operator explicitly overrides it.
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai'

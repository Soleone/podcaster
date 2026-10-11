// The hosted demo has no host process. Voice enrollment and voice preview are the only API calls the demo build still
// makes, so they answer with a clear message instead of a 404. Readiness, bootstrap and stop are skipped in that build.
module.exports = (req, res) => {
  res.statusCode = 501;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'Not available in the hosted demo. Run npm run demo locally for the same screens.' }));
};

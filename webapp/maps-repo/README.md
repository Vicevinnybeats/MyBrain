# mybrain-maps (private)

The maps shown in your MyBrain web app. Each folder in `maps/` is one project:

    maps/<project>/map.json    the map (written by mybrain-publish)
    maps/<project>/report.md   its Brain Scan

You never edit this by hand: maps arrive from `/mybrain publish` in Claude Code
or from the MyBrain GitHub workflow in your projects. Every push rebuilds the
app on Cloudflare (build command `sh build.sh`, deploy command `npx wrangler deploy`).

To remove a map: delete its folder in `maps/` and commit.

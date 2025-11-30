const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// -----------------------------------------------
// PostgreSQL Connection
// -----------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgres://postgres:PocStupaI25!@poc-test.crmwyw868lh4.ap-south-1.rds.amazonaws.com:5432/postgres",
    ssl: { rejectUnauthorized: false }
});

// Test connection
pool.connect()
    .then(() => console.log("Connected to PostgreSQL"))
    .catch(err => console.error("DB Connection Failed:", err.message));

const val = (v) => v === undefined ? null : v;

let LIVE_JSON = null;

function buildPlayerJSON(m) {
    const a = m.assignment || {};

    // 1️DOUBLES (convert into array of objects)
    if (a.player_a1 && a.player_a2 && a.player_b1 && a.player_b2) {
        return {
            a: [
                a.player_a1 ? { name: a.player_a1.name } : null,
                a.player_a2 ? { name: a.player_a2.name } : null
            ].filter(Boolean),
            b: [
                a.player_b1 ? { name: a.player_b1.name } : null,
                a.player_b2 ? { name: a.player_b2.name } : null
            ].filter(Boolean)
        };
    }

    // 2️SINGLES (object format)
    if (a.player_a && a.player_b) {
        return {
            a: a.player_a ? { name: a.player_a.name } : null,
            b: a.player_b ? { name: a.player_b.name } : null
        };
    }

    // 3️ MIXED / GRAND RALLY
    if (a.teamA?.mixed1 || a.teamA?.mixed2) {
        return {
            a: {
                mixed1: [
                    a.teamA?.mixed1?.player1 ? { name: a.teamA.mixed1.player1.name } : null,
                    a.teamA?.mixed1?.player2 ? { name: a.teamA.mixed1.player2.name } : null
                ].filter(Boolean),
                mixed2: [
                    a.teamA?.mixed2?.player1 ? { name: a.teamA.mixed2.player1.name } : null,
                    a.teamA?.mixed2?.player2 ? { name: a.teamA.mixed2.player2.name } : null
                ].filter(Boolean)
            },
            b: {
                mixed1: [
                    a.teamB?.mixed1?.player1 ? { name: a.teamB.mixed1.player1.name } : null,
                    a.teamB?.mixed1?.player2 ? { name: a.teamB.mixed1.player2.name } : null
                ].filter(Boolean),
                mixed2: [
                    a.teamB?.mixed2?.player1 ? { name: a.teamB.mixed2.player1.name } : null,
                    a.teamB?.mixed2?.player2 ? { name: a.teamB.mixed2.player2.name } : null
                ].filter(Boolean)
            }
        };
    }

    return { a: null, b: null };
}


function parseServeTeam(val) {
    if (!val) return null;
    const x = val.toString().trim().charAt(0);
    return (x === "A" || x === "B") ? x : null;
}



// -----------------------------------------------
// INSERT MATCH (main or submatch)
app.post("/save_match", async (req, res) => {
    const m = req.body;

    console.log("🟦 /save_match CALLED");
    console.log("➡ Incoming payload:", JSON.stringify(m, null, 2));

    try {
        const isMain = !m.parent_id;
        let matchNo = m.match_no;

        if (!m.parent_id) {
            const r = await pool.query(
                "SELECT COALESCE(MAX(match_no), 0) AS max_no FROM matches WHERE tie_id = $1 AND parent_id IS NULL",
                [0]
            );
            matchNo = r.rows[0].max_no + 1;
        }

        const servingParsed = parseServeTeam(m.servingTeam ?? m.serving_team);
        const firstServeParsed = parseServeTeam(m.firstServeTeam ?? m.first_serve_team);

        const pj = buildPlayerJSON(m);

        const sql = `
        INSERT INTO matches (
            id, tie_id, parent_id, match_no, name, type,
            team_a_id, team_b_id,
            serving_team, first_serve_team,
            score_a, score_b,
            points_a, points_b,
            completed, winner, golden_point,
            assignment,
            player_a, player_b,
            stage, match_type,
            created_at, updated_at
        )
        VALUES (
            $1, 0, $2, $3, $4, $5,
            0, 0,
            $6, $7,
            $8, $9,
            $10, $11,
            $12, $13, $14,
            $15,
            $16, $17,
            $18, $19,
            NOW(), NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
            parent_id = EXCLUDED.parent_id,
            match_no = EXCLUDED.match_no,
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            serving_team = EXCLUDED.serving_team,
            first_serve_team = EXCLUDED.first_serve_team,
            score_a = EXCLUDED.score_a,
            score_b = EXCLUDED.score_b,
            points_a = EXCLUDED.points_a,
            points_b = EXCLUDED.points_b,
            completed = EXCLUDED.completed,
            winner = EXCLUDED.winner,
            golden_point = EXCLUDED.golden_point,
            assignment = EXCLUDED.assignment,
            player_a = EXCLUDED.player_a,
            player_b = EXCLUDED.player_b,
            stage = EXCLUDED.stage,
            match_type = EXCLUDED.match_type,
            updated_at = NOW()
        `;

        const params = [
            m.id,
            m.parent_id,
            matchNo,
            m.name || null,
            (m.type === "main" ? "regular" : m.type || "regular"),

            servingParsed,
            firstServeParsed,

            m.score_a || 0,
            m.score_b || 0,

            isMain ? (m.points_a || 0) : 0,
            isMain ? (m.points_b || 0) : 0,

            m.completed || false,
            m.winner || null,
            m.golden_point || false,

            JSON.stringify(val(m.assignment)),
            JSON.stringify(pj.a),
            JSON.stringify(pj.b),

            m.stage || null,
            m.match_type || null
        ];

        await pool.query(sql, params);

        return res.json({ success: true });

    } catch (err) {
        console.error("ERROR IN /save_match:", err);
        return res.status(500).json({ error: err.message });
    }
});



// -----------------------------------------------
// UPDATE MATCH (winner, score, assignment)
// -----------------------------------------------
app.post("/update_match", async (req, res) => {
    const m = req.body;

    try {
        console.log("UPDATE_MATCH CALLED WITH:", m);

        // 1️ Fetch the existing match
        const existingRes = await pool.query(
            `SELECT points_a, points_b, parent_id
             FROM matches WHERE id = $1`,
            [m.id]
        );

        if (existingRes.rows.length === 0) {
            return res.status(404).json({ error: "Match not found" });
        }

        const existing = existingRes.rows[0];
        const isSub = !!existing.parent_id;

        // 2️Calculate submatch points (only applied to SUBMATCHES)
        const subPointsA = m.winner === "A" ? 1 : 0;
        const subPointsB = m.winner === "B" ? 1 : 0;

        const newPointsA = isSub ? subPointsA : existing.points_a;
        const newPointsB = isSub ? subPointsB : existing.points_b;

        const updateSQL = `
            UPDATE matches SET
                score_a = $1,
                score_b = $2,
                winner = $3,
                completed = $4,
                serving_team = $5,
                first_serve_team = $6,
                assignment = $7,
                points_a = $8,
                points_b = $9,
                status = $10,
                updated_at = NOW()
            WHERE id = $11
        `;

        await pool.query(updateSQL, [
            m.scoreA ?? m.score_a ?? 0,
            m.scoreB ?? m.score_b ?? 0,
            m.winner || null,
            m.winner ? true : m.completed || false,
            parseServeTeam(m.servingTeam),
            parseServeTeam(m.firstServeTeam),
            JSON.stringify(m.assignment || null),
            newPointsA,
            newPointsB,
            "Completed",
            m.id
        ]);

        console.log("✔ MATCH UPDATED");

        // 3️If it's a submatch → update the parent’s total points
        if (isSub) {
            console.log("➡ Updating parent aggregated points...");

            const parentRes = await pool.query(
                `SELECT points_a, points_b FROM matches WHERE id = $1`,
                [existing.parent_id]
            );

            const parent = parentRes.rows[0];

            const updatedA = parent.points_a + subPointsA;
            const updatedB = parent.points_b + subPointsB;

            await pool.query(
                `UPDATE matches 
                 SET points_a = $1, points_b = $2, updated_at = NOW()
                 WHERE id = $3`,
                [updatedA, updatedB, existing.parent_id]
            );

            console.log("✔ Parent Updated:", updatedA, updatedB);

            return res.json({
                success: true,
                parentUpdated: true,
                new_parent_points_a: updatedA,
                new_parent_points_b: updatedB
            });
        }

        // 4️For main matches → done
        res.json({ success: true, message: "Main match updated" });

    } catch (err) {
        console.error("ERROR in /update_match:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/live_json_update", (req, res) => {
    const { json, liveMatch, tieId } = req.body;

    LIVE_JSON = {
        tieId,
        liveMatch,
        json
    };

    return res.json({ success: true });
});

app.post("/live_json_clear", (req, res) => {
    LIVE_JSON = null;
    res.json({ success: true });
});


// -----------------------------------------------
// -----------------------------------------------
// -----------------------------------------------
// GET COMPLETED MATCHES WITH SUBMATCHES (with names)
// -----------------------------------------------
app.get("/get_matches", async (req, res) => {
    try {
        const mains = await pool.query(`
            SELECT * 
            FROM matches
            WHERE parent_id IS NULL
            ORDER BY match_no ASC
        `);

        const result = [];

        for (const main of mains.rows) {
            const mainMatch = {
                id: main.id,
                name: main.name,
                match_no: main.match_no,
                points_a: main.points_a,
                points_b: main.points_b,
                stage: main.stage || null,
                match_type: main.match_type || null,
                submatches: []
            };

            const subs = await pool.query(`
                SELECT *
                FROM matches
                WHERE parent_id = $1
                ORDER BY match_no ASC
            `, [main.id]);

            mainMatch.submatches = subs.rows.map(sub => {
                let row = {
                    id: sub.id,
                    name: sub.name,
                    match_no: sub.match_no,
                    score_a: sub.score_a,
                    score_b: sub.score_b,
                    winner: sub.winner,
                    completed: sub.completed,
                    serving_team: sub.serving_team,
                    first_serve_team: sub.first_serve_team,
                    points_a: sub.points_a,
                    points_b: sub.points_b,
                    golden_point: sub.golden_point,
                    status: sub.status || "Upcoming",
                    playerA: typeof sub.player_a === "string" ? JSON.parse(sub.player_a) : sub.player_a,
                    playerB: typeof sub.player_b === "string" ? JSON.parse(sub.player_b) : sub.player_b
                };

                // OVERRIDE ONLY LIVE SUBMATCH
                if (LIVE_JSON &&
                    LIVE_JSON.tieId == sub.parent_id &&
                    LIVE_JSON.liveMatch == sub.match_no) {

                    const live = LIVE_JSON.json.tie.matches.find(m => m.id == sub.match_no);

                    if (live) {
                        row.score_a = live.scoreA;
                        row.score_b = live.scoreB;
                        row.serving_team = live.servingTeam;
                        row.first_serve_team = live.firstServeTeam;
                        row.status = "Live";
                    }
                }

                return row;
            });

            result.push(mainMatch);
        }

        return res.json(result);

    } catch (err) {
        console.error("ERROR in /get_matches:", err);
        res.status(500).json({ error: err.message });
    }
});



app.post("/save_team", async (req, res) => {
    const t = req.body;

    try {
        await pool.query("BEGIN");

        // 1) Get old rank
        const oldRankQuery = `
            SELECT rank FROM team_standings WHERE team_id = $1
        `;
        const oldRankResult = await pool.query(oldRankQuery, [t.teamId]);
        const oldRank = oldRankResult.rows[0]?.rank || null;

        const newRank = t.rank;

        // CASE A: Team is moving UP (3 → 1)
        if (oldRank !== null && newRank < oldRank) {
            await pool.query(`
                UPDATE team_standings
                SET rank = rank + 1
                WHERE rank >= $1 AND rank < $2 AND team_id != $3
            `, [newRank, oldRank, t.teamId]);
        }

        // CASE B: Team is moving DOWN (1 → 3)
        else if (oldRank !== null && newRank > oldRank) {
            await pool.query(`
                UPDATE team_standings
                SET rank = rank - 1
                WHERE rank <= $1 AND rank > $2 AND team_id != $3
            `, [newRank, oldRank, t.teamId]);
        }

        // CASE C: New team (oldRank = null)
        else if (oldRank === null) {
            await pool.query(`
                UPDATE team_standings
                SET rank = rank + 1
                WHERE rank >= $1
            `, [newRank]);
        }

        // NOW INSERT/UPDATE TEAM
        const upsertSQL = `
            INSERT INTO team_standings (
                team_id, team_name,
                ties_played, ties_won, ties_draw, ties_lost,
                tie_points, match_points_won,
                qualified,
                rank,
                created_at, updated_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                NOW(), NOW()
            )
            ON CONFLICT (team_id)
            DO UPDATE SET
                team_name = EXCLUDED.team_name,
                ties_played = EXCLUDED.ties_played,
                ties_won = EXCLUDED.ties_won,
                ties_draw = EXCLUDED.ties_draw,
                ties_lost = EXCLUDED.ties_lost,
                tie_points = EXCLUDED.tie_points,
                match_points_won = EXCLUDED.match_points_won,
                qualified = EXCLUDED.qualified,
                rank = EXCLUDED.rank,
                updated_at = NOW();
        `;

        await pool.query(upsertSQL, [
            t.teamId,
            t.teamName,
            t.tiesPlayed,
            t.tiesWon,
            t.tiesDraw,
            t.tiesLost,
            t.tiePoints,
            t.matchPointsWon,
            t.qualified,
            newRank
        ]);

        await pool.query("COMMIT");
        res.json({ success: true });

    } catch (err) {
        await pool.query("ROLLBACK");
        console.error("ERR:", err);
        res.status(500).json({ error: err.message });
    }
});




app.get("/get_standings", async (req, res) => {
    try {
        const sql = `
            SELECT *
FROM team_standings
ORDER BY rank::integer ASC;
        `;

        const result = await pool.query(sql);

        res.json({
            success: true,
            standings: result.rows
        });

    } catch (err) {
        console.error("ERROR in /get_standings:", err);
        res.status(500).json({ error: err.message });
    }
});




const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

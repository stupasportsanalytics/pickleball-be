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

// -----------------------------------------------
// INSERT MATCH (main or submatch)
app.post("/save_match", async (req, res) => {
    const m = req.body;

    console.log("🟦 /save_match CALLED");
    console.log("➡ Incoming payload:", JSON.stringify(m, null, 2));

    try {
        const isMain = !m.parent_id;

        // -------- Auto-increment match_no for main matches --------
        let matchNo = m.match_no;

        if (!m.parent_id) {
            console.log("🟩 Main match detected → Calculating match_no...");

            const r = await pool.query(
                "SELECT COALESCE(MAX(match_no), 0) AS max_no FROM matches WHERE tie_id = $1 AND parent_id IS NULL",
                [0]
            );

            console.log("➡ Current MAX match_no:", r.rows[0].max_no);
            matchNo = r.rows[0].max_no + 1;
            console.log("➡ New match_no will be:", matchNo);
        } else {
            console.log("🟦 Submatch detected → Using match_no:", matchNo);
        }

        // FIX serving team
        const servingTeam = (m.servingTeam ?? m.serving_team ?? null);
        const firstServeTeam = (m.firstServeTeam ?? m.first_serve_team ?? null);

        console.log("➡ Serving Team before parse:", servingTeam);
        console.log("➡ First Serve Team before parse:", firstServeTeam);

        const servingParsed = servingTeam ? servingTeam.toString().trim().charAt(0) : null;
        const firstServeParsed = firstServeTeam ? firstServeTeam.toString().trim().charAt(0) : null;

        console.log("➡ Parsed Serving Team:", servingParsed);
        console.log("➡ Parsed First Serve Team:", firstServeParsed);

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

            val(m.assignment),

            m.playerA || null,
            m.playerB || null
        ];


        
        const result = await pool.query(sql, params);

       
        return res.json({ success: true, result: result.command });

    } catch (err) {
        
        return res.status(500).json({ error: err.message, hint: "See server logs" });
    }
});


// -----------------------------------------------
// UPDATE MATCH (winner, score, assignment)
// -----------------------------------------------
app.post("/update_match", async (req, res) => {
    const m = req.body;


    try {
        const updateSub = `
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
        player_a = $10,
        player_b = $11,
        updated_at = NOW()
    WHERE id = $12
`;

        const subPointsA = m.winner === "A" ? 1 : 0;
        const subPointsB = m.winner === "B" ? 1 : 0;

        await pool.query(updateSub, [
            m.scoreA ?? m.score_a ?? 0,
            m.scoreB ?? m.score_b ?? 0,
            m.winner || null,
            m.winner ? true : m.completed || false,
            (m.servingTeam ?? m.serving_team ?? null)?.toString().trim().charAt(0) || null,
            (m.firstServeTeam ?? m.first_serve_team ?? null)?.toString().trim().charAt(0) || null,
            val(m.assignment),
            subPointsA,
            subPointsB,
            m.playerA || null,
            m.playerB || null,
            m.id
        ]);

        if (!m.parent_id) {
            return res.json({ success: true, message: "Main match updated" });
        }

        // Update parent aggregated points
        const getParent = await pool.query(
            `SELECT points_a, points_b FROM matches WHERE id = $1`,
            [m.parent_id]
        );

        const parent = getParent.rows[0];

        const newPointsA = parent.points_a + subPointsA;
        const newPointsB = parent.points_b + subPointsB;

        const updateParent = `
            UPDATE matches SET
                points_a = $1,
                points_b = $2,
                updated_at = NOW()
            WHERE id = $3
        `;

        await pool.query(updateParent, [
            newPointsA,
            newPointsB,
            m.parent_id
        ]);

        res.json({
            success: true,
            parentUpdated: true,
            new_parent_points_a: newPointsA,
            new_parent_points_b: newPointsB
        });

    } catch (err) {
        console.error("ERROR in /update_match:", err);
        res.status(500).json({ error: err.message });
    }
});

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
                submatches: []
            };


            const subs = await pool.query(`
                SELECT *
                FROM matches
                WHERE parent_id = $1
                ORDER BY match_no ASC
            `, [main.id]);


            mainMatch.submatches = subs.rows.map(sub => ({
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

               
                playerA: sub.player_a,
                playerB: sub.player_b
            }));


            result.push(mainMatch);
        }

        res.json(result);

    } catch (err) {
        console.error("ERROR in /get_completed_matches:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/save_team", async (req, res) => {
    const t = req.body;

    try {
        const sql = `
            INSERT INTO team_standings (
                team_id, team_name,
                ties_played, ties_won, ties_draw, ties_lost,
                tie_points, match_points_won,
                qualified,
                created_at, updated_at
            ) VALUES (
                $1,$2,
                $3,$4,$5,$6,
                $7,$8,
                $9,
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
                updated_at = NOW();
        `;

        await pool.query(sql, [
            t.teamId,
            t.teamName,

            t.tiesPlayed,
            t.tiesWon,
            t.tiesDraw,
            t.tiesLost,

            t.tiePoints,
            t.matchPointsWon,

            t.qualified
        ]);

        res.json({ success: true });

    } catch (err) {
        console.error("ERROR in /save_team:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/get_standings", async (req, res) => {
    try {
        const sql = `
            SELECT *
            FROM team_standings
            ORDER BY tie_points DESC, match_points_won DESC;
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

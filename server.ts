import express from 'express';
import * as path from 'path';
import * as fs from 'fs';

const app = express();
app.use(express.static('public'));
app.use(express.json());

// ディレクトリ一覧取得API
app.get('/api/list', (req, res) => {
    try {
        const defaultDir = 'C:\\Users\\a2189\\OneDrive\\Desktop\\mRNA PCR';
        let targetDir = req.query.dir ? String(req.query.dir) : defaultDir;
        
        targetDir = path.resolve(targetDir);

        if (!fs.existsSync(targetDir)) {
            targetDir = 'C:\\Users\\a2189\\OneDrive\\Desktop'; // フォールバック
        }

        const items = fs.readdirSync(targetDir, { withFileTypes: true });
        
        let list = items.map(item => {
            const itemPath = path.join(targetDir, item.name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(itemPath).mtimeMs; } catch(e) {}
            return {
                name: item.name,
                isDir: item.isDirectory(),
                path: itemPath,
                mtimeMs: mtimeMs
            };
        });

        // フォルダ、または "RNA " で始まるCSV/TSVファイルのみに絞り込み
        list = list.filter(item => {
            if (item.isDir) return true;
            const nameLow = item.name.toLowerCase();
            const isTargetExt = nameLow.endsWith('.csv') || nameLow.endsWith('.tsv') || nameLow.endsWith('.txt');
            return item.name.startsWith('RNA ') && isTargetExt;
        });

        // フォルダを先（アルファベット順）、次にファイルを新しい順（更新日時降順）にソート
        list.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            if (a.isDir && b.isDir) return a.name.localeCompare(b.name);
            return b.mtimeMs - a.mtimeMs;
        });

        const parent = path.dirname(targetDir);

        res.json({
            current: targetDir,
            parent: parent !== targetDir ? parent : null,
            items: list
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// 計算およびファイル保存API
app.post('/api/process', (req, res) => {
    try {
        const filePath = req.body.path;
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ error: '無効なファイルパスです' });
        }

        let fileContent;
        try {
            fileContent = fs.readFileSync(filePath, { encoding: 'utf16le' });
            if (fileContent.indexOf('\t') === -1 && fileContent.indexOf(',') === -1) {
                fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
            }
        } catch (err) {
            return res.status(500).json({ error: 'ファイルの読み込みに失敗しました' });
        }

        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        if (lines.length === 0) {
            return res.status(400).json({ error: 'ファイルが空です' });
        }

        const headers = lines[0].split('\t').map(h => h.trim());
        const getColIndex = (name: string) => headers.findIndex(h => h === name);

        const nameIdx = getColIndex("Sample Name");
        const concIdx = getColIndex("Nucleic Acid(ng/uL)");
        const a260280Idx = getColIndex("A260/A280");
        const a260230Idx = getColIndex("A260/A230");

        if ([nameIdx, concIdx, a260280Idx, a260230Idx].includes(-1)) {
            return res.status(400).json({ error: '必要なカラムが見つかりません。見つかったカラム: ' + headers.join(', ') });
        }

        type SampleInfo = {
            sampleName: string;
            conc: number;
            a260280: string;
            a260230: string;
            status: string;
            addDdwVol: number | string;
            message: string;
        };

        const results: SampleInfo[] = [];

        for (let i = 1; i < lines.length; i++) {
            const row = lines[i].split('\t');
            if (row.length <= Math.max(nameIdx, concIdx, a260280Idx, a260230Idx)) continue;

            const sampleName = row[nameIdx].trim();
            const concStr = row[concIdx].trim();
            const a260280 = row[a260280Idx].trim();
            const a260230 = row[a260230Idx].trim();
            
            const naConc = parseFloat(concStr);
            let status = '';
            let addDdwVol: number | string = '-';
            let message = '';

            if (isNaN(naConc) || naConc <= 0) {
                status = 'error';
                message = '濃度エラー';
            } else if (naConc < 181.8) {
                status = 'insufficient';
                message = '濃度不足';
            } else {
                status = 'dilute';
                // 19uLのRNAを181.8ng/uLに希釈するために必要なDDWの量
                // V_final = (19 * naConc) / 181.8
                // DDW = V_final - 19
                const ddw = (naConc * 19) / 181.8 - 19;
                addDdwVol = Number(ddw.toFixed(2));
                message = '希釈可能';
            }

            results.push({
                sampleName, conc: naConc, a260280, a260230, status, addDdwVol, message
            });
        }

        const insufficientSamples = results.filter(r => r.status === 'insufficient');
        const diluteSamples = results.filter(r => r.status === 'dilute');
        const errorSamples = results.filter(r => r.status === 'error');

        const todayStr = new Date().toISOString().split('T')[0];
        let mdOutput = `# RNA希釈プロトコル (${todayStr})\n\n`;

        const printMdTable = (samples: SampleInfo[], title: string, note: string = '') => {
            if (samples.length > 0) {
                mdOutput += `## ${title}\n`;
                if (note) mdOutput += `${note}\n\n`;
                
                const cols = ["Sample Name", "Conc(ng/uL)", "A260/280", "A260/230", "Add DDW(μL)"];
                mdOutput += `| ${cols.join(' | ')} |\n`;
                mdOutput += `| ${cols.map(() => '---').join(' | ')} |\n`;
                
                for (const s of samples) {
                    mdOutput += `| ${s.sampleName} | ${s.conc} | ${s.a260280} | ${s.a260230} | ${s.addDdwVol} |\n`;
                }
                mdOutput += '\n';
            }
        };

        printMdTable(insufficientSamples, "⚠️ 濃度不足サンプル（181.8ng/uL未満）");
        printMdTable(diluteSamples, "🧪 希釈必要サンプル", "19μLのRNA溶液にDDWを加えて181.8ng/uLに調整する量");

        if (errorSamples.length > 0) {
            mdOutput += "## ❌ エラーサンプル\n";
            mdOutput += "| Sample Name | Conc(ng/uL) | Message |\n";
            mdOutput += "| --- | --- | --- |\n";
            for (const s of errorSamples) {
                mdOutput += `| ${s.sampleName} | ${s.conc} | ${s.message} |\n`;
            }
            mdOutput += '\n';
        }

        // Markdown出力処理 (省略せず既存のまま)
        mdOutput += "## 📊 サマリー\n";
        mdOutput += `- 総数: ${results.length}\n`;
        mdOutput += `- 処理可能: ${diluteSamples.length}\n`;
        mdOutput += `- 濃度不足: ${insufficientSamples.length}\n`;

        // 同じディレクトリにMDファイルを保存
        const parsedPath = path.parse(filePath);
        const outFileName = parsedPath.name + "_result.md";
        const outFilePath = path.join(parsedPath.dir, outFileName);
        
        fs.writeFileSync(outFilePath, mdOutput, 'utf8');

        // スマホ用JSONの出力 (docs/latest_result.json)
        const jsonData = {
            date: new Date().toISOString(),
            filename: parsedPath.base,
            summary: {
                total: results.length,
                dilutable: diluteSamples.length,
                insufficient: insufficientSamples.length
            },
            diluteSamples: diluteSamples.map(s => ({ sampleName: s.sampleName, conc: s.conc, addDdwVol: s.addDdwVol })),
            insufficientSamples: insufficientSamples.map(s => ({ sampleName: s.sampleName, conc: s.conc })),
            errorSamples: errorSamples.map(s => ({ sampleName: s.sampleName, message: s.message }))
        };

        const docsDir = path.join(process.cwd(), 'docs');
        if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);
        fs.writeFileSync(path.join(docsDir, 'latest_result.json'), JSON.stringify(jsonData, null, 2), 'utf8');

        // GitHubへ自動プッシュ (非同期)
        const { exec } = require('child_process');
        exec('git add docs/latest_result.json && git commit -m "Auto-update latest result" && git push', (err: any) => {
            if (err) console.error("Git push failed:", err);
            else console.log("Successfully pushed latest results to GitHub.");
        });

        res.json({ markdown: mdOutput, savedPath: outFilePath });
    } catch (error: any) {
        console.error(error);
        res.status(500).json({ error: error.message || 'サーバーエラーが発生しました' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ローカルサーバーが起動しました！`);
    console.log(`ブラウザで http://localhost:${PORT} にアクセスしてください。`);
});

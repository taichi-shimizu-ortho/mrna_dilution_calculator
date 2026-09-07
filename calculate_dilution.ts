import * as fs from 'fs';
import * as path from 'path';

// 引数からファイルパスを取得、なければデフォルトのファイル名を使用
const args = process.argv.slice(2);
const defaultFilePath = 'RNA 1_26_2026 5_19_30 PM.csv';
const filePath = args.length > 0 ? args[0] : defaultFilePath;

function main() {
    // 1. 本日の日付を取得
    const todayStr = new Date().toISOString().split('T')[0];

    // 2. CSV（TSV）ファイルの読み込み
    let fileContent: string;
    try {
        // NanoDropなどの書き出しはUTF-16(LE)が多い
        fileContent = fs.readFileSync(filePath, { encoding: 'utf16le' });
    } catch (error: any) {
        // フォールバックとしてUTF-8で再試行
        try {
            fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
        } catch (err: any) {
            console.error(`エラー: ${filePath} が見つからないか、読み込めません。`);
            process.exit(1);
        }
    }

    const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) {
        console.error('エラー: ファイルが空です。');
        process.exit(1);
    }

    const headers = lines[0].split('\t').map(h => h.trim());
    const getColIndex = (name: string) => headers.findIndex(h => h === name);

    const nameIdx = getColIndex("Sample Name");
    const concIdx = getColIndex("Nucleic Acid(ng/uL)");
    const a260280Idx = getColIndex("A260/A280");
    const a260230Idx = getColIndex("A260/A230");

    if ([nameIdx, concIdx, a260280Idx, a260230Idx].includes(-1)) {
        console.error('エラー: 必要なカラムが見つかりません。');
        console.error(`見つかったカラム: ${headers.join(', ')}`);
        process.exit(1);
    }

    type SampleInfo = {
        sampleName: string;
        conc: number;
        a260280: string;
        a260230: string;
        status: string;
        rnaVol: number | string;
        ddwVol: number | string;
        message: string;
    };

    const results: SampleInfo[] = [];

    // 3. データ行の計算
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split('\t');
        if (row.length <= Math.max(nameIdx, concIdx, a260280Idx, a260230Idx)) continue;

        const sampleName = row[nameIdx].trim();
        const concStr = row[concIdx].trim();
        const a260280 = row[a260280Idx].trim();
        const a260230 = row[a260230Idx].trim();
        
        const naConc = parseFloat(concStr);
        let status = '';
        let rnaVol: number | string = '-';
        let ddwVol: number | string = '-';
        let message = '';

        if (isNaN(naConc) || naConc <= 0) {
            status = 'error';
            message = '濃度エラー';
        } else {
            const rnaAmountIn5_5ul = naConc * 5.5;
            if (rnaAmountIn5_5ul < 1000) {
                status = 'insufficient';
                message = '濃度不足';
            } else if (naConc < 1000) {
                const volRNA = 1000 / naConc;
                const volDDW = 5.5 - volRNA;
                status = 'dilute';
                rnaVol = Number(volRNA.toFixed(2));
                ddwVol = Number(volDDW.toFixed(2));
                message = '希釈必要';
            } else {
                const volDDW = naConc * 20 / 1000 - 20;
                status = 'concentrated';
                rnaVol = 20;
                ddwVol = Number(volDDW.toFixed(2));
                message = '高濃度希釈';
            }
        }

        results.push({
            sampleName,
            conc: naConc,
            a260280,
            a260230,
            status,
            rnaVol,
            ddwVol,
            message
        });
    }

    // 4. グループ分け
    const insufficientSamples = results.filter(r => r.status === 'insufficient');
    const diluteSamples = results.filter(r => r.status === 'dilute');
    const concentratedSamples = results.filter(r => r.status === 'concentrated');
    const errorSamples = results.filter(r => r.status === 'error');

    // 5. Markdown出力用関数
    const printMdTable = (samples: SampleInfo[], title: string, note: string = '') => {
        if (samples.length > 0) {
            console.log(`## ${title}`);
            if (note) console.log(`${note}\n`);
            
            const cols = ["Sample Name", "Conc(ng/uL)", "A260/280", "A260/230", "RNA Vol", "DDW Vol"];
            const header = `| ${cols.join(' | ')} |`;
            const separator = `| ${cols.map(() => '---').join(' | ')} |`;
            
            console.log(header);
            console.log(separator);
            
            for (const s of samples) {
                console.log(`| ${s.sampleName} | ${s.conc} | ${s.a260280} | ${s.a260230} | ${s.rnaVol} | ${s.ddwVol} |`);
            }
            console.log('\n');
        }
    };

    // 6. 最終出力
    console.log(`# RNA希釈プロトコル (${todayStr})\n`);

    printMdTable(insufficientSamples, "⚠️ 濃度不足サンプル（5.5μLでも1000ng未満）");
    printMdTable(diluteSamples, "🧪 希釈必要サンプル（1000ng/uL未満）", "1000ngを得るためのRNA量 + DDWで5.5μLに調整");
    printMdTable(concentratedSamples, "💧 高濃度サンプル（1000ng/uL以上）", "1000ng/uLに希釈するためのDDW添加量（RNA 20μL使用）");

    if (errorSamples.length > 0) {
        console.log("## ❌ エラーサンプル");
        console.log("| Sample Name | Conc(ng/uL) | Message |");
        console.log("| --- | --- | --- |");
        for (const s of errorSamples) {
            console.log(`| ${s.sampleName} | ${s.conc} | ${s.message} |`);
        }
        console.log('\n');
    }

    console.log("## 📊 サマリー");
    console.log(`- 総数: ${results.length}`);
    console.log(`- 処理可能: ${diluteSamples.length + concentratedSamples.length}`);
    console.log(`- 濃度不足: ${insufficientSamples.length}`);
}

main();

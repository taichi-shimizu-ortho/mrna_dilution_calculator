import pandas as pd
import numpy as np
from datetime import datetime

# 1. 本日の日付を取得
today_str = datetime.now().strftime("%Y-%m-%d")

# CSVファイルの読み込み
file_path = "RNA 1_26_2026 5_19_30 PM.csv"
try:
    df = pd.read_csv(file_path, sep='\t', encoding="utf-16")
except FileNotFoundError:
    print(f"エラー: {file_path} が見つかりません。")
    exit()

# 必要なカラムを抽出
cols = ["Sample Name", "Nucleic Acid(ng/uL)", "A260/A280", "A260/A230"]
df = df[cols].copy()

# 計算関数の定義
def calculate_dilution_volumes(na_conc):
    if na_conc <= 0:
        return {"status": "error", "rna_vol": "-", "ddw_vol": "-", "message": "濃度エラー"}
    
    rna_amount_in_5_5ul = na_conc * 5.5
    
    if rna_amount_in_5_5ul < 1000:
        return {"status": "insufficient", "rna_vol": "-", "ddw_vol": "-", "message": "濃度不足"}
    elif na_conc < 1000:
        rna_vol = 1000 / na_conc
        ddw_vol = 5.5 - rna_vol
        return {"status": "dilute", "rna_vol": round(rna_vol, 2), "ddw_vol": round(ddw_vol, 2), "message": "希釈必要"}
    else:
        ddw_vol = na_conc * 20 / 1000 - 20
        return {"status": "concentrated", "rna_vol": 20, "ddw_vol": round(ddw_vol, 2), "message": "高濃度希釈"}

# 計算実行
volumes_df = pd.DataFrame(df["Nucleic Acid(ng/uL)"].apply(calculate_dilution_volumes).tolist())
df = pd.concat([df, volumes_df], axis=1)

# グループ分け
insufficient_samples = df[df["status"] == "insufficient"]
dilute_samples = df[df["status"] == "dilute"]
concentrated_samples = df[df["status"] == "concentrated"]
error_samples = df[df["status"] == "error"]

# --- Markdown出力用関数 ---
def print_md_table(target_df, title, note=""):
    if not target_df.empty:
        print(f"## {title}")
        if note: print(f"{note}\n")
        
        # 表示用にカラム名を整理
        display_df = target_df.copy()
        display_df.columns = [
            "Sample Name", "Conc(ng/uL)", "A260/280", "A260/230", 
            "status", "RNA Vol", "DDW Vol", "message"
        ]
        
        # 必要な列だけを選択
        cols_to_show = ["Sample Name", "Conc(ng/uL)", "A260/280", "A260/230", "RNA Vol", "DDW Vol"]
        target = display_df[cols_to_show]

        # Markdownテーブルの作成
        header = "| " + " | ".join(target.columns) + " |"
        separator = "| " + " | ".join(["---"] * len(target.columns)) + " |"
        print(header)
        print(separator)
        
        for _, row in target.iterrows():
            row_str = "| " + " | ".join(map(str, row.values)) + " |"
            print(row_str)
        print("\n")

# --- 最終出力 ---
print(f"# RNA希釈プロトコル ({today_str})\n")

print_md_table(insufficient_samples, "⚠️ 濃度不足サンプル（5.5μLでも1000ng未満）")
print_md_table(dilute_samples, "🧪 希釈必要サンプル（1000ng/uL未満）", "1000ngを得るためのRNA量 + DDWで5.5μLに調整")
print_md_table(concentrated_samples, "💧 高濃度サンプル（1000ng/uL以上）", "1000ng/uLに希釈するためのDDW添加量（RNA 20μL使用）")

if not error_samples.empty:
    print("## ❌ エラーサンプル")
    print("| Sample Name | Conc(ng/uL) | Message |")
    print("| --- | --- | --- |")
    for _, row in error_samples.iterrows():
        print(f"| {row['Sample Name']} | {row['Nucleic Acid(ng/uL)']} | {row['message']} |")

print("## 📊 サマリー")
print(f"- 総数: {len(df)}")
print(f"- 処理可能: {len(dilute_samples) + len(concentrated_samples)}")
print(f"- 濃度不足: {len(insufficient_samples)}")
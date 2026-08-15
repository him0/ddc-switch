---
name: ddc-display
description: Control an external display over DDC/CI with the `ddc` CLI — switch the input source between ports (type-c / hdmi / dp), read the current input, and set brightness, contrast or volume. Use when the user wants to switch the monitor input, hand the screen over to another machine, toggle the display, or inspect and adjust the external display (ディスプレイの入力を切り替える / モニタを HDMI に / 画面を切り替えて / 輝度を変えて).
---

# 外部ディスプレイを DDC/CI で操作する

`ddc` は macOS (Apple Silicon) から DDC/CI で外部ディスプレイを操作する CLI。
呼ばれたときだけ起動して終わる。常駐プロセスは無い。

見つからない場合は `~/.local/bin/ddc` を直接叩く (Raycast のように PATH が絞られた環境向けに
そこへ配置されている)。無ければ `ddc-switch` リポジトリで `just install` が必要。

## 入力名はポート名であって機器名ではない

入力は **モニタ側のポート** で呼ぶ: `type-c` / `hdmi` / `dp`。
`mac` や `windows` のような機器名は使わない。Type-C に挿す機器は入れ替わるので、
機器名で呼ぶと名前が実態とずれる。

**使える名前は環境ごとに違う。推測せず `ddc inputs` で確認する。**
名前は `~/.config/ddc-switch/config.json` の `inputs` に書かれていて、生の VCP 値
(例: `ddc 17`) も受け付ける。

## コマンド

読み取りだけのもの (画面は変わらない。許可なく実行してよい):

```sh
ddc                  # 現在の入力・輝度・コントラスト・音量
ddc status --json    # 同じ内容を JSON で (パースするならこちら)
ddc inputs           # 設定されている入力名と VCP 値
ddc displays         # DDC で見えているディスプレイ
```

表示を変えるもの:

```sh
ddc hdmi             # HDMI に切り替え (入力名をそのまま渡す)
ddc type-c           # Type-C に切り替え
ddc switch <名前>     # 名前がサブコマンドと衝突するときはこちら
ddc toggle           # config の toggle ペアを往復
ddc toggle a b       # 指定した 2 つを往復
ddc brightness 60    # 輝度 (0-100)
ddc contrast 75
ddc volume 30 / ddc mute / ddc unmute
ddc pbp 36 hdmi      # PBP モード (off:0 / 50-50:36) と副入力
```

## 入力切替はユーザーの画面を奪う

`ddc hdmi` のような切替は、実際にモニタの表示が別のマシンへ移る。

- **実行前に必ずユーザーの許可を取る。** 状態を読むだけの確認で済むなら切り替えない
- 単発の切替は数秒で戻ってくるので、そのまま実行してよい
- **複数回の切替を含む検証スクリプトはフォアグラウンドで実行しない。**
  画面が移ると出力が読めなくなる。バックグラウンド実行 + ログファイルへの書き出しにする

  ```sh
  ./scripts/whatever.sh > /tmp/ddc.log 2>&1 &
  ```

- そのスクリプトには **最後に元の入力へ戻す処理を必ず入れる。**
  戻せないとユーザーがモニタ背面のジョイスティックで手動復帰することになる
- Mac が Type-C で繋がっている構成では、HDMI に切り替えた後も Type-C 側の DDC が
  生きたままなので Mac から戻せる。ただしこれは機種依存の実測結果で、別のモニタでは成り立たない可能性がある

## 遅いのと、失敗するのは正常

- `ddc status` は 4 プロパティを読むので 3-6 秒かかる。切替は 1 プロパティなのでもっと速い。
  タイムアウトを短く設定しない
- DDC の読み取りは約 45% の確率で失敗する。`ddc` 側が読み直して補正しているが、
  それでも `Could not get a stable read of ...` で落ちることがある。
  この場合は **そのまま 1 回リトライしてよい**。設定やハードの問題ではない
- **DDC コマンドを並行実行しない。** DDC は I2C の上に乗っていて多重化できない。
  `ddc` を複数同時に走らせないこと (壊れた値は返らないが、読み取りエラーで落ちる)

## 切替結果の読み方

切替後に値を読み直して検証している。出力は 3 パターンある。

- `type-c → hdmi` — 切り替わったことを読み直して確認できた
- 「読み直しに失敗した」旨の但し書き付き — コマンドは送ったが確認できていない。
  切り替わっている可能性が高い。`ddc status` で確認する
- `Warning: read back N instead of ...` — 要求と違う値が返った。
  そのモニタがその入力に対応していない可能性がある

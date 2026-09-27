# サードパーティのデータ

このプロジェクト自体のコードは MIT ライセンス（[LICENSE](LICENSE)）。**MIT ライセンスは、以下に記す埋め込みの英単語の一覧（`src/data/words-en.js` および、それを埋め込んだ `dist/bundle.js`）には及ばない**。この一覧には、下記のとおり別の著作権表示・許諾条件がある。

## 英単語の一覧（12dicts 6.0.2、AGID ほか）

`src/data/words-en.js`（と、それを埋め込んだ `dist/bundle.js`）の英単語の一覧は、次のファイルから `scripts/build-words.js` で作った（上位 40,000 語、約 222 KiB）。

- 12dicts release 6.0.2（2016 年 6 月、Alan Beale）
  - 配布元: http://wordlist.aspell.net/12dicts/ （公式の zip: `http://downloads.sourceforge.net/wordlist/12dicts-6.0.2.zip`）
  - 原本は SourceForge から直接は取得できなかった（自動取得を 403 で拒否）。そのため、12dicts-6.0.2 をそのまま入れている GitHub 上のリポジトリと、別のミラー（hack.esolangs.org）から取得し、`2+2+3frq.txt` は取得元どうしでハッシュが一致することを確かめた。
- このリポジトリに入れた原本（手を加えていない。改行は CRLF のまま）:

| ファイル | SHA-256 |
|---|---|
| `data/12dicts-6.0.2/2+2+3frq.txt`（頻度の帯つきの一覧） | `2b38e3f669191b41ce85d45f3827d1c3c846fdc929c23418d50c7e58145ee16f` |
| `data/12dicts-6.0.2/2of12inf.txt`（語形変化を含む一覧） | `55d23dfc4b2058cd317a86b368d0d95b743e1f3a0acaec5cbb310f54f6f9c254` |
| `data/12dicts-6.0.2/ReadMe.html`（12dicts の説明書き） | `ed518c8bce143643ad0c688c4381e1dab3ccae60cc76fde66742b0ba94857c2f` |
| `data/12dicts-6.0.2/agid.txt`（AGID の説明と著作権表示） | `57a64a96d7eb9035e697f2bd214439da82d2e3090e4450f9734d2b7bdbb40c1a` |

### ライセンス

12dicts の多くのリストはパブリックドメインだが、**ここで使った `2of12inf` と `2+2+3frq` は AGID（Automatically Generated Inflection Database）に依存しているため、パブリックドメインではない**。12dicts の ReadMe（原文のまま）:

> The 12dicts lists were compiled by Alan Beale. I explicitly release them to the public domain, but request acknowledgment of their use. (Actually, the dependency of the 2of12inf list and the 2+2+3 lists on AGID prevents their release into the public domain. However, I do not impose any additional requirements on their use beyond those imposed by AGID and its sources, as described in agid.txt.)

したがって、AGID とその元データの条件にしたがう。どれも再配布・改変・商用利用を認める寛容な条件で、求められているのは著作権表示と許諾文を残すこと。以下は `agid.txt` からの原文のまま（全文は `data/12dicts-6.0.2/agid.txt`）。

#### AGID

```
  Copyright 2000 by Kevin Atkinson

  Permission to use, copy, modify, distribute and sell this database,
  the associated scripts, the output created form the scripts and its
  documentation for any purpose is hereby granted without fee,
  provided that the above copyright notice appears in all copies and
  that both that copyright notice and this permission notice appear in
  supporting documentation. Kevin Atkinson makes no representations
  about the suitability of this array for any purpose. It is provided
  "as is" without express or implied warranty.
```

#### WordNet 1.6（AGID の品詞データの元）

```
    This software and database is being provided to you, the LICENSEE, by
    Princeton University under the following license.  By obtaining, using
    and/or copying this software and database, you agree that you have
    read, understood, and will comply with these terms and conditions.:

    Permission to use, copy, modify and distribute this software and
    database and its documentation for any purpose and without fee or
    royalty is hereby granted, provided that you agree to comply with
    the following copyright notice and statements, including the disclaimer,
    and that the same appear on ALL copies of the software, database and
    documentation, including modifications that you make for internal
    use or for distribution.

    WordNet 1.6 Copyright 1997 by Princeton University.  All rights reserved.

    THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON
    UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
    IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON
    UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANT-
    ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
    OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT
    INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR
    OTHER RIGHTS.

    The name of Princeton University or Princeton may not be used in
    advertising or publicity pertaining to distribution of the software
    and/or database.  Title to copyright in this software, database and
    any associated documentation shall at all times remain with
    Princeton University and LICENSEE agrees to preserve same.
```

#### UK Advanced Cryptics Dictionary（AGID の単語リストの元のひとつ）

```
     Copyright (c) J Ross Beresford 1993-1999. All Rights Reserved.

     The following restriction is placed on the use of this
     publication: if The UK Advanced Cryptics Dictionary is used
     in a software package or redistributed in any form, the
     copyright notice must be prominently displayed and the text
     of this document must be included verbatim.

     There are no other restrictions: I would like to see the
     list distributed as widely as possible.
```

#### パブリックドメインの元データ

AGID の単語リストのそのほかの元（Moby Words と Moby の品詞データベース、ENABLE2K とその補遺、YAWL、Jargon File Word List）はパブリックドメイン。ENABLE の作者は出典の明記を求めている: ENABLE2K word list（ENABLE master word list, WORD.LST）。

#### 謝辞

12dicts: Alan Beale。AGID: Kevin Atkinson。

#### UKACD の「この文書」について（注記）

UKACD の許諾文にある「if The UK Advanced Cryptics Dictionary is used in a software package or redistributed in any form, ... the text of this document must be included verbatim」の「this document」が指す範囲（UKACD 配布物の README 全体か、この著作権段落のみか）は、原本（配布元のテキストファイル）を直接確認できておらず不確実。ただし AGID・SCOWL・aspell 等、UKACD を採録して配布している既知のプロジェクトはいずれもこの著作権段落のみを逐語で収録しており、本書もその慣行にならって、この段落を「this document」として逐語収録した。

## 実行時に使うもの（同梱しない）

以下は Steam Frame に最初から入っているものを実行時に呼び出すだけで、このプロジェクトには含めていない（再配布していない）。

- **Anthy**（libanthy、かな漢字変換）: LGPL-2.1-or-later。辞書データの一部は GPL-2.0-or-later。差し込み役（Python）が実行時に `libanthy.so.0` を読み込んで使う。
- **Python 3** と **aiohttp**（差し込み役の実行環境）: それぞれ PSF License と Apache-2.0。

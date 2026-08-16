#!/usr/bin/env python3
"""Build WattPatch's compact ChamSys fixture catalog.

The ChamSys table supplies fixture identity and DMX profiles, not electrical
power. Power data is joined only on conservative manufacturer/model matches
from the existing official WattPatch records, manufacturer-published GDTF
files, Open Fixture Library, and QLC+. Crowd-sourced sources remain estimates
in the application.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable


CHAMSYS_URL = "https://secure.chamsys.co.uk/bugtracker/personality_list.php"

CATEGORIES = [
    "Moving-head spot",
    "Moving-head wash",
    "Moving-head beam",
    "Moving-head hybrid",
    "LED PAR",
    "Conventional PAR",
    "Fresnel",
    "Profile",
    "Followspot",
    "Blinder",
    "Sunstrip",
    "Strobe",
    "LED bar",
    "Pixel bar",
    "Effect light",
    "Laser",
    "Practical light",
    "Dimmer channel",
    "Custom electrical load",
    "Hazer",
    "Fog machine",
]
CATEGORY_INDEX = {name: index for index, name in enumerate(CATEGORIES)}

MANUFACTURER_ALIASES = {
    "5star": "5starsystems",
    "5star systems": "5starsystems",
    "adj": "americandj",
    "american dj": "americandj",
    "american dj adj": "americandj",
    "afx": "afxlight",
    "afx light": "afxlight",
    "astera led technology": "astera",
    "beamz pro": "beamz",
    "blizzard lighting llc": "blizzard",
    "chauvet": "chauvet",
    "chauvet dj": "chauvet",
    "chauvet pro": "chauvet",
    "chauvet professional": "chauvet",
    "clay paky": "claypaky",
    "claypaky": "claypaky",
    "electronic theatre controls": "etc",
    "dts lighting": "dts",
    "elation professional": "elation",
    "german light products": "glp",
    "gtd lighting": "gtd",
    "hes": "highendsystems",
    "high end": "highendsystems",
    "high end systems": "highendsystems",
    "jb lighting": "jblighting",
    "jb-lighting": "jblighting",
    "jb systems": "jbsystems",
    "martin professional": "martin",
    "philips showline": "philipsvarilite",
    "philips vari-lite": "philipsvarilite",
    "pro-lights": "prolights",
    "robe lighting": "robe",
    "oxo light": "oxo",
    "sgm light": "sgm",
    "vari lite": "varilite",
    "vari-lite": "varilite",
    "vari*lite": "varilite",
}


@dataclass(frozen=True)
class PowerCandidate:
    manufacturer: str
    model: str
    maximum_w: float
    minimum_w: float
    category: str
    kind: str
    source_url: str
    priority: int


def compact_key(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    value = value.replace("&", "and").replace("+", "plus")
    value = re.sub(r"\bmark\s*(ii|2)\b", "mk2", value)
    value = re.sub(r"\bmk\s*ii\b", "mk2", value)
    value = re.sub(r"\bmark\s*(iii|3)\b", "mk3", value)
    value = re.sub(r"\bmk\s*iii\b", "mk3", value)
    return re.sub(r"[^a-z0-9]+", "", value)


def manufacturer_key(value: str) -> str:
    alias = MANUFACTURER_ALIASES.get(value.strip().lower())
    return alias or compact_key(value)


def model_key(manufacturer: str, model: str) -> str:
    key = compact_key(model)
    if manufacturer_key(manufacturer) == "robe" and key.startswith("robin"):
        key = key[5:]
    return key


def identity_key(manufacturer: str, model: str) -> tuple[str, str]:
    return manufacturer_key(manufacturer), model_key(manufacturer, model)


def stable_id(manufacturer: str, model: str) -> str:
    digest = hashlib.sha256(f"{manufacturer}\0{model}".encode()).hexdigest()[:16]
    return f"chamsys-{digest}"


def strip_tags(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def parse_chamsys_html(content: str) -> tuple[dict, list[list]]:
    rows: list[list] = []
    for row_html in re.findall(
        r'<tr[^>]+class="row-\d+"[^>]*>(.*?)</tr>', content, flags=re.I | re.S
    ):
        cells = [strip_tags(cell) for cell in re.findall(r"<td[^>]*>(.*?)</td>", row_html, flags=re.I | re.S)]
        if len(cells) != 5 or not cells[3].isdigit():
            continue
        rows.append([cells[0], cells[1], cells[2], int(cells[3]), cells[4]])

    title = re.search(r"MagicQ Personality Library\s*-\s*([^<]+)", content, flags=re.I)
    declared = re.search(r"currently\s+(\d+)\s+personalities", content, flags=re.I)
    if not rows:
        raise ValueError("No ChamSys personality rows found")
    if declared and int(declared.group(1)) != len(rows):
        raise ValueError(f"ChamSys declared {declared.group(1)} rows but {len(rows)} were parsed")
    metadata = {
        "libraryDateText": title.group(1).strip() if title else "Unknown",
        "personalityCount": len(rows),
        "sourceUrl": CHAMSYS_URL,
    }
    return metadata, rows


def load_chamsys(path: Path | None) -> tuple[dict, list[list]]:
    if path and path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        metadata = {
            "libraryDateText": data["metadata"]["library_date_text"],
            "libraryDate": data["metadata"]["library_date_iso"],
            "personalityCount": data["metadata"]["declared_personalities"],
            "sourceUrl": data["metadata"]["source_url"],
        }
        rows = [row[:5] for row in data["personalities"]]
        return metadata, rows

    if path:
        return parse_chamsys_html(path.read_text(encoding="utf-8"))

    request = urllib.request.Request(CHAMSYS_URL, headers={"User-Agent": "WattPatch catalog updater"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return parse_chamsys_html(response.read().decode("utf-8"))


def git_revision(path: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "main"


def category_for(text: str) -> str:
    value = text.lower()
    if "hazer" in value or "haze" in value:
        return "Hazer"
    if "smoke" in value or "fog" in value:
        return "Fog machine"
    if "followspot" in value or "follow spot" in value:
        return "Followspot"
    if "fresnel" in value:
        return "Fresnel"
    if "sunstrip" in value:
        return "Sunstrip"
    if "blinder" in value:
        return "Blinder"
    if "strobe" in value:
        return "Strobe"
    if "laser" in value:
        return "Laser"
    if "dimmer" in value:
        return "Dimmer channel"
    if "pixel bar" in value or "matrix" in value or "pixelpanel" in value:
        return "Pixel bar"
    if "led bar" in value or "batten" in value:
        return "LED bar"
    if "moving head" in value or "moving-head" in value or " mh" in f" {value}":
        if "beam" in value and "wash" not in value and "spot" not in value:
            return "Moving-head beam"
        if "wash" in value and "beam" not in value and "spot" not in value:
            return "Moving-head wash"
        if "spot" in value or "profile" in value:
            return "Moving-head spot"
        return "Moving-head hybrid"
    if "profile" in value or "leko" in value or "source four" in value or "source 4" in value:
        return "Profile"
    if "par" in value:
        return "LED PAR" if "led" in value or "rgb" in value or "color" in value else "Conventional PAR"
    return "Effect light"


def load_builtin(path: Path | None) -> list[PowerCandidate]:
    if not path:
        return []
    records = json.loads(path.read_text(encoding="utf-8"))
    return [
        PowerCandidate(
            record["manufacturer"],
            record["model"],
            float(record["maxPowerW"]),
            float(record["maxPowerW"]),
            record["category"],
            "manufacturer",
            record["sourceUrl"],
            3,
        )
        for record in records
        if record.get("maxPowerW", 0) > 0 and record.get("sourceUrl")
    ]


def load_ofl(path: Path | None) -> tuple[list[PowerCandidate], str]:
    if not path:
        return [], ""
    fixtures_dir = path / "fixtures"
    manufacturers = json.loads((fixtures_dir / "manufacturers.json").read_text(encoding="utf-8"))
    revision = git_revision(path)
    candidates: list[PowerCandidate] = []
    for fixture_path in fixtures_dir.glob("*/*.json"):
        try:
            record = json.loads(fixture_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        power = record.get("physical", {}).get("power")
        if not isinstance(power, (int, float)) or power <= 0 or not record.get("name"):
            continue
        relative = fixture_path.relative_to(path).as_posix()
        manufacturer = manufacturers.get(fixture_path.parent.name, {}).get("name", fixture_path.parent.name)
        categories = " ".join(record.get("categories", []))
        candidates.append(
            PowerCandidate(
                manufacturer,
                record["name"],
                float(power),
                float(power),
                category_for(f"{categories} {record['name']}"),
                "open-fixture-library",
                f"https://github.com/OpenLightingProject/open-fixture-library/blob/{revision}/{relative}",
                1,
            )
        )
    return candidates, revision


def load_gdtf(path: Path | None) -> list[PowerCandidate]:
    """Load the small power export produced from the public GDTF Fixture Finder.

    Only manufacturer-uploaded GDTF records are exported. If the same GDTF UUID
    appears more than once, the newest indexed revision wins.
    """
    if not path:
        return []
    records = json.loads(path.read_text(encoding="utf-8"))
    newest_by_uuid: dict[str, dict] = {}
    for record in records:
        uuid = str(record.get("uuid", ""))
        if not uuid or not isinstance(record.get("power"), (int, float)) or record["power"] <= 0:
            continue
        current = newest_by_uuid.get(uuid)
        if current is None or record.get("revisionDate", 0) > current.get("revisionDate", 0):
            newest_by_uuid[uuid] = record
    return [
        PowerCandidate(
            record["manufacturer"],
            record["model"],
            float(record["power"]),
            float(record["power"]),
            category_for(record["model"]),
            "gdtf-manufacturer",
            record["sourceUrl"],
            2,
        )
        for record in newest_by_uuid.values()
    ]


def qlc_files(paths: Iterable[Path]) -> Iterable[tuple[Path, Path, str]]:
    for root in paths:
        revision = git_revision(root)
        for fixture_path in root.rglob("*.qxf"):
            yield root, fixture_path, revision


def load_qlc(paths: list[Path]) -> tuple[list[PowerCandidate], list[str]]:
    candidates: list[PowerCandidate] = []
    revisions: list[str] = []
    for root in paths:
        revisions.append(git_revision(root))
    for root, fixture_path, revision in qlc_files(paths):
        try:
            xml_root = ET.parse(fixture_path).getroot()
        except (OSError, ET.ParseError):
            continue
        namespace = xml_root.tag.partition("}")[0] + "}" if "}" in xml_root.tag else ""
        manufacturer = xml_root.findtext(namespace + "Manufacturer") or ""
        model = xml_root.findtext(namespace + "Model") or ""
        fixture_type = xml_root.findtext(namespace + "Type") or ""
        powers = {
            float(element.attrib["PowerConsumption"])
            for element in xml_root.findall(".//" + namespace + "Technical")
            if element.attrib.get("PowerConsumption", "").replace(".", "", 1).isdigit()
            and float(element.attrib["PowerConsumption"]) > 0
        }
        if not manufacturer or not model or not powers:
            continue
        relative = fixture_path.relative_to(root).as_posix()
        repository = "qlcplus-extras" if root.name == "qlcplus-extras" else "qlcplus"
        candidates.append(
            PowerCandidate(
                manufacturer,
                model,
                max(powers),
                min(powers),
                category_for(f"{fixture_type} {model}"),
                "qlc-plus",
                f"https://github.com/mcallegari/{repository}/blob/{revision}/{relative}",
                1,
            )
        )
    return candidates, revisions


def normalize_number(value: float) -> int | float:
    return int(value) if value.is_integer() else value


def build_catalog(
    chamsys_metadata: dict,
    rows: list[list],
    candidates: list[PowerCandidate],
    source_metadata: dict,
) -> dict:
    grouped: OrderedDict[tuple[str, str], list[list]] = OrderedDict()
    for manufacturer, model, mode, channels, file_name in rows:
        grouped.setdefault((manufacturer, model), []).append([mode, int(channels), file_name])

    by_identity: dict[tuple[str, str], list[PowerCandidate]] = defaultdict(list)
    for candidate in candidates:
        by_identity[identity_key(candidate.manufacturer, candidate.model)].append(candidate)

    fixtures: list[list] = []
    source_counts: dict[str, int] = defaultdict(int)
    conflicts = 0
    for (manufacturer, model), profiles in grouped.items():
        category = category_for(model)
        matched = by_identity.get(identity_key(manufacturer, model), [])
        highest_priority = max((candidate.priority for candidate in matched), default=0)
        considered = [candidate for candidate in matched if candidate.priority == highest_priority]
        power: list | None = None
        if considered:
            maximum = max(candidate.maximum_w for candidate in considered)
            minimum = min(candidate.minimum_w for candidate in considered)
            selected = max(considered, key=lambda candidate: (candidate.maximum_w, candidate.priority))
            category = selected.category
            source_counts[selected.kind] += 1
            if maximum != minimum:
                conflicts += 1
            power = [
                normalize_number(maximum),
                normalize_number(minimum),
                selected.kind,
                selected.source_url,
                len({candidate.source_url for candidate in considered}),
            ]
        row = [
            stable_id(manufacturer, model),
            manufacturer,
            model,
            CATEGORY_INDEX[category],
            profiles,
        ]
        if power:
            row.append(power)
        fixtures.append(row)

    known = sum(len(row) == 6 for row in fixtures)
    metadata = {
        "schemaVersion": 1,
        "generatedDate": date.today().isoformat(),
        "libraryDate": chamsys_metadata.get("libraryDate", ""),
        "libraryDateText": chamsys_metadata.get("libraryDateText", ""),
        "sourceUrl": chamsys_metadata.get("sourceUrl", CHAMSYS_URL),
        "manufacturerCount": len({row[1] for row in fixtures}),
        "fixtureCount": len(fixtures),
        "personalityCount": sum(len(row[4]) for row in fixtures),
        "powerMatchedFixtureCount": known,
        "unknownPowerFixtureCount": len(fixtures) - known,
        "conflictingPowerFixtureCount": conflicts,
        "powerSourceCounts": dict(sorted(source_counts.items())),
        **source_metadata,
    }
    if metadata["personalityCount"] != chamsys_metadata["personalityCount"]:
        raise ValueError("Generated personality count does not match the ChamSys source")
    return {"metadata": metadata, "fixtures": fixtures}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chamsys", type=Path, help="Saved ChamSys HTML or parsed JSON; downloads when omitted")
    parser.add_argument("--builtin", type=Path, help="WattPatch's verified fixtures.json")
    parser.add_argument("--ofl", type=Path, help="Open Fixture Library repository checkout")
    parser.add_argument("--gdtf", type=Path, help="Manufacturer power export from the public GDTF Fixture Finder")
    parser.add_argument("--qlc", type=Path, action="append", default=[], help="QLC+ repository checkout (repeatable)")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    chamsys_metadata, rows = load_chamsys(args.chamsys)
    builtin = load_builtin(args.builtin)
    gdtf = load_gdtf(args.gdtf)
    ofl, ofl_revision = load_ofl(args.ofl)
    qlc, qlc_revisions = load_qlc(args.qlc)
    source_metadata = {
        "openFixtureLibraryRevision": ofl_revision,
        "qlcPlusRevisions": qlc_revisions,
        "gdtfFixtureFinderUrl": "https://www.gdtf.eu/gdtf/gdtf_fixturefinder/",
    }
    catalog = build_catalog(chamsys_metadata, rows, [*builtin, *gdtf, *ofl, *qlc], source_metadata)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    metadata = catalog["metadata"]
    print(
        f"Wrote {metadata['fixtureCount']} fixtures / {metadata['personalityCount']} personalities; "
        f"{metadata['powerMatchedFixtureCount']} have sourced power data"
    )


if __name__ == "__main__":
    main()

from pathlib import Path
import re

import numpy as np
import pandas as pd


# =========================================================
# PATHS
# =========================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

RAW_DIR = (
    PROJECT_ROOT
    / "data"
    / "ac_energy"
    / "raw"
    / "splitsmart"
)

OUTPUT_DIR = (
    PROJECT_ROOT
    / "data"
    / "ac_energy"
    / "processed"
)

OUTPUT_DIR.mkdir(
    parents=True,
    exist_ok=True
)


# =========================================================
# HELPERS
# =========================================================

def get_room_from_text(text):
    text = str(text).upper().replace("_", "").replace("-", "")

    if "A200" in text:
        return "A200"

    if "C108" in text:
        return "C108"

    if "D250" in text:
        return "D250"

    if "CC1" in text:
        return "CC-1"

    return None


def number_from_value(value):
    if pd.isna(value):
        return np.nan

    match = re.search(
        r"[-+]?\d*\.?\d+",
        str(value).replace(",", "")
    )

    if match:
        return float(match.group())

    return np.nan


# =========================================================
# READ CONTEXT FILES
# =========================================================

context_data = {}

context_files = [
    f
    for f in RAW_DIR.glob("*.csv")
    if "context" in f.name.lower()
]


print("Reading context files...")


for file in context_files:

    room = get_room_from_text(
        file.name
    )

    if room is None:
        print(
            f"Could not identify context: {file.name}"
        )
        continue

    context = pd.read_csv(
        file
    )

    context.columns = [
        str(c).strip()
        for c in context.columns
    ]

    values = {}

    for _, row in context.iterrows():

        parameter = str(
            row.iloc[0]
        ).strip().lower()

        value = (
            row.iloc[1]
            if len(row) > 1
            else None
        )

        values[parameter] = value


    tonnage = np.nan
    people = np.nan
    heat_load = np.nan
    activity_schedule = "Unknown"
    environment_type = "Unknown"


    for parameter, value in values.items():

        if "tonnage" in parameter:
            tonnage = number_from_value(value)

        elif "people" in parameter:
            people = number_from_value(value)

        elif (
            "static" in parameter
            and "heat" in parameter
        ):
            heat_load = number_from_value(value)

        elif "activity" in parameter:
            activity_schedule = str(value)

        elif "environment" in parameter:
            environment_type = str(value)


    context_data[room] = {

        "tonnage":
            tonnage,

        "people":
            people,

        "static_heat_load_btu":
            heat_load,

        "activity_schedule":
            activity_schedule,

        "environment_type":
            environment_type
    }


    print(
        f"  {room}: "
        f"tonnage={tonnage}, "
        f"people={people}, "
        f"environment={environment_type}"
    )


# =========================================================
# FIND AC DATA FILES
# =========================================================

data_files = [
    file
    for file in RAW_DIR.glob("*.csv")
    if "context" not in file.name.lower()
]


print(
    f"\nFound {len(data_files)} possible AC data files."
)


all_windows = []


# =========================================================
# PROCESS EVERY AC FILE
# =========================================================

for file in sorted(data_files):

    print(
        f"\nProcessing: {file.name}"
    )


    try:

        df = pd.read_csv(
            file,
            low_memory=False
        )

    except Exception as error:

        print(
            f"  Could not read: {error}"
        )

        continue


    required = [
        "Time_Stamp",
        "Device_ID",
        "Current",
        "voltage",
        "Power_Factor",
        "room_temp",
        "External_temp",
        "Humidity"
    ]


    missing = [
        column
        for column in required
        if column not in df.columns
    ]


    if missing:

        print(
            f"  Skipped - missing columns: {missing}"
        )

        continue


    # -----------------------------------------------------
    # DETERMINE AC ID
    # -----------------------------------------------------

    ids = (
        df["Device_ID"]
        .dropna()
        .astype(str)
    )

    if len(ids) == 0:

        print(
            "  Skipped - no Device_ID"
        )

        continue


    ac_id = ids.mode().iloc[0]


    # Determine room using AC ID first
    room = get_room_from_text(
        ac_id
    )

    # Fall back to filename
    if room is None:

        room = get_room_from_text(
            file.name
        )


    # The unusual SplitSmart CC-1 file may not have
    # CC-1 in its downloaded filename.
    if (
        room is None
        and "011019" in file.name
    ):
        room = "CC-1"


    print(
        f"  AC ID: {ac_id}"
    )

    print(
        f"  Room: {room}"
    )


    # -----------------------------------------------------
    # TIMESTAMP
    # -----------------------------------------------------

    df["timestamp"] = pd.to_datetime(
        df["Time_Stamp"],
        errors="coerce",
        utc=True
    )


    # -----------------------------------------------------
    # NUMERIC COLUMNS
    # -----------------------------------------------------

    numeric_columns = [
        "Current",
        "voltage",
        "Power_Factor",
        "room_temp",
        "External_temp",
        "Humidity"
    ]


    if "unit_consumption" in df.columns:

        numeric_columns.append(
            "unit_consumption"
        )


    for column in numeric_columns:

        df[column] = pd.to_numeric(
            df[column],
            errors="coerce"
        )


    # -----------------------------------------------------
    # CLEAN ELECTRICAL VALUES
    # -----------------------------------------------------

    df["power_factor"] = (
        df["Power_Factor"]
        .abs()
    )


    df.loc[
        (df["power_factor"] <= 0)
        | (df["power_factor"] > 1),
        "power_factor"
    ] = np.nan


    df.loc[
        (df["voltage"] < 180)
        | (df["voltage"] > 280),
        "voltage"
    ] = np.nan


    df.loc[
        (df["Current"] < 0)
        | (df["Current"] > 100),
        "Current"
    ] = np.nan


    # -----------------------------------------------------
    # CALCULATE POWER
    # -----------------------------------------------------

    df["power_kw"] = (
        df["voltage"]
        * df["Current"]
        * df["power_factor"]
        / 1000
    )


    df.loc[
        (df["power_kw"] < 0)
        | (df["power_kw"] > 15),
        "power_kw"
    ] = np.nan


    # -----------------------------------------------------
    # CLEAN ROOM TEMPERATURE
    # -----------------------------------------------------

    df.loc[
        (df["room_temp"] < 10)
        | (df["room_temp"] > 45),
        "room_temp"
    ] = np.nan


    # -----------------------------------------------------
    # CLEAN OUTDOOR TEMPERATURE
    # -----------------------------------------------------

    # Some rows appear to contain Kelvin.
    kelvin = (
        (df["External_temp"] > 150)
        & (df["External_temp"] < 350)
    )


    df.loc[
        kelvin,
        "External_temp"
    ] = (
        df.loc[
            kelvin,
            "External_temp"
        ]
        - 273.15
    )


    # Zero is treated as unavailable.
    df.loc[
        df["External_temp"] == 0,
        "External_temp"
    ] = np.nan


    df.loc[
        (df["External_temp"] < -20)
        | (df["External_temp"] > 60),
        "External_temp"
    ] = np.nan


    # -----------------------------------------------------
    # CLEAN HUMIDITY
    # -----------------------------------------------------

    df.loc[
        (df["Humidity"] < 0)
        | (df["Humidity"] > 100),
        "Humidity"
    ] = np.nan


    # -----------------------------------------------------
    # PREPARE TIME ORDER
    # -----------------------------------------------------

    df = df.dropna(
        subset=[
            "timestamp",
            "power_kw"
        ]
    )


    df = df.sort_values(
        "timestamp"
    ).reset_index(drop=True)


    if len(df) == 0:

        print(
            "  No usable rows."
        )

        continue


    # -----------------------------------------------------
    # DETECT AC OPERATING STATE
    # -----------------------------------------------------
    #
    # This is ONLY used during dataset construction.
    #
    # Real EcoTrack will get ON/OFF from IR commands.
    # -----------------------------------------------------

    df["ac_on"] = (
        df["power_kw"] >= 0.10
    ).astype(int)


    # -----------------------------------------------------
    # FIND GAPS / OPERATING SESSIONS
    # -----------------------------------------------------

    df["gap_seconds"] = (
        df["timestamp"]
        .diff()
        .dt.total_seconds()
    )


    previous_state = (
        df["ac_on"]
        .shift(1)
        .fillna(0)
    )


    new_session = (

        (df["ac_on"] == 1)

        & (

            (previous_state == 0)

            | (df["gap_seconds"] > 300)

        )
    )


    df["session_number"] = (
        new_session
        .cumsum()
    )


    # Keep operating readings
    operating = df[
        df["ac_on"] == 1
    ].copy()


    if len(operating) == 0:

        print(
            "  No operating readings."
        )

        continue


    # -----------------------------------------------------
    # RUNTIME SINCE AC TURNED ON
    # -----------------------------------------------------

    session_start = (
        operating
        .groupby(
            "session_number"
        )["timestamp"]
        .transform("min")
    )


    operating[
        "runtime_minutes"
    ] = (

        operating["timestamp"]
        - session_start

    ).dt.total_seconds() / 60


    # -----------------------------------------------------
    # IDENTIFIERS
    # -----------------------------------------------------

    operating["ac_id"] = ac_id

    operating["room"] = (
        room
        if room is not None
        else "Unknown"
    )


    # -----------------------------------------------------
    # 10-MINUTE WINDOWS
    # -----------------------------------------------------

    operating["window"] = (
        operating["timestamp"]
        .dt.floor("10min")
    )


    windows = (
        operating

        .groupby(
            [
                "ac_id",
                "room",
                "session_number",
                "window"
            ],
            as_index=False
        )

        .agg(

            power_kw=(
                "power_kw",
                "mean"
            ),

            room_temp_c=(
                "room_temp",
                "mean"
            ),

            outdoor_temp_c=(
                "External_temp",
                "mean"
            ),

            humidity=(
                "Humidity",
                "mean"
            ),

            runtime_minutes=(
                "runtime_minutes",
                "max"
            ),

            sample_count=(
                "power_kw",
                "count"
            )
        )
    )


    windows = windows.rename(
        columns={
            "window":
                "timestamp"
        }
    )


    # Require at least 2 raw measurements
    # inside a 10-minute window.
    windows = windows[
        windows["sample_count"] >= 2
    ].copy()


    # -----------------------------------------------------
    # ADD CONTEXT DATA
    # -----------------------------------------------------

    context = context_data.get(
        room,
        {}
    )


    windows["tonnage"] = (
        context.get(
            "tonnage",
            np.nan
        )
    )


    windows["people"] = (
        context.get(
            "people",
            np.nan
        )
    )


    windows[
        "static_heat_load_btu"
    ] = context.get(
        "static_heat_load_btu",
        np.nan
    )


    windows[
        "activity_schedule"
    ] = context.get(
        "activity_schedule",
        "Unknown"
    )


    windows[
        "environment_type"
    ] = context.get(
        "environment_type",
        "Unknown"
    )


    # -----------------------------------------------------
    # TIME FEATURES
    # -----------------------------------------------------

    windows["hour"] = (
        windows["timestamp"]
        .dt.hour
    )


    windows["day_of_week"] = (
        windows["timestamp"]
        .dt.dayofweek
    )


    windows["month"] = (
        windows["timestamp"]
        .dt.month
    )


    windows["is_weekend"] = (
        windows["day_of_week"]
        >= 5
    ).astype(int)


    # -----------------------------------------------------
    # TEMPERATURE FEATURES
    # -----------------------------------------------------

    windows[
        "indoor_outdoor_temp_diff"
    ] = (

        windows["room_temp_c"]
        - windows["outdoor_temp_c"]

    )


    windows = windows.sort_values(
        [
            "ac_id",
            "session_number",
            "timestamp"
        ]
    )


    windows[
        "room_temp_change_10m"
    ] = (

        windows
        .groupby(
            [
                "ac_id",
                "session_number"
            ]
        )["room_temp_c"]
        .diff()
    )


    all_windows.append(
        windows
    )


    print(
        f"  Raw usable rows: {len(df):,}"
    )

    print(
        f"  Operating rows: {len(operating):,}"
    )

    print(
        f"  10-minute windows: {len(windows):,}"
    )


# =========================================================
# COMBINE ALL ACs
# =========================================================

if not all_windows:

    raise RuntimeError(
        "No SplitSmart AC datasets were processed."
    )


combined = pd.concat(
    all_windows,
    ignore_index=True
)


combined = combined.sort_values(
    [
        "ac_id",
        "timestamp"
    ]
).reset_index(drop=True)


# =========================================================
# SAVE
# =========================================================

OUTPUT_FILE = (
    OUTPUT_DIR
    / "ac_energy_training_v2.csv"
)


combined.to_csv(
    OUTPUT_FILE,
    index=False
)


# =========================================================
# SUMMARY
# =========================================================

print("\n==========================================")
print("EcoTrack SplitSmart V2 preprocessing done")
print("==========================================")

print(
    f"Total 10-minute windows: "
    f"{len(combined):,}"
)

print(
    f"Unique AC units: "
    f"{combined['ac_id'].nunique()}"
)


print("\nRows per AC:")

print(
    combined["ac_id"]
    .value_counts()
    .to_string()
)


print("\nRooms:")

print(
    combined[
        [
            "ac_id",
            "room",
            "tonnage",
            "environment_type"
        ]
    ]
    .drop_duplicates()
    .to_string(index=False)
)


print("\nAverage power per AC:")

print(
    combined
    .groupby("ac_id")["power_kw"]
    .mean()
    .round(3)
    .to_string()
)


print(
    f"\nSaved to:\n{OUTPUT_FILE}"
)
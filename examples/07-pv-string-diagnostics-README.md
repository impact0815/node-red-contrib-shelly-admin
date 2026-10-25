[`07-pv-string-diagnostics-README.de.md`](07-pv-string-diagnostics-README.de.md)

# PV String Diagnostics add-on (FlowFuse Dashboard 2.0)

`07-pv-string-diagnostics-flowfuse.json` adds a configurable two-string plausibility check to the AlphaESS dashboard example. It is intended for installations where the two MPPT strings have different installed DC capacities.

Default example configuration:

- PV1: 10 x 405 Wp = 4.05 kWp
- PV2: 8 x 405 Wp = 3.24 kWp
- Expected instantaneous power ratio under comparable conditions: 1.25 : 1
- Minimum combined PV power for evaluation: 500 W
- Warning threshold: 15% normalized deviation
- Critical threshold: 25% normalized deviation
- Smoothing: median of up to 10 qualified samples

The comparison normalizes each string by installed Wp before comparing them. This avoids falsely flagging the smaller string simply because it contains fewer panels. Evaluation is paused below the configured minimum PV power. Short cloud, shade and MPPT effects are reduced by using several qualified samples. This is a plausibility indicator, not an electrical fault diagnosis; different orientation, tilt, shading, temperature and module tolerance can create legitimate differences.

## Import into the existing AlphaESS dashboard

1. Import `07-pv-string-diagnostics-flowfuse.json`.
2. Replace the existing **Dashboard model** function with **Build dashboard model + PV config**, or copy the `pvConfig` addition into the existing function. Keep the existing outputs from that model function to the main dashboard widgets.
3. Assign **PV string diagnostics & configuration** to the same FlowFuse Dashboard group/page as the AlphaESS main dashboard. Set its order directly after the existing AlphaESS main widget.
4. Connect the output of **Build dashboard model + PV config** to **PV string diagnostics & configuration**.
5. Connect the output of **PV string diagnostics & configuration** to **Save PV string configuration**.
6. Connect **Save PV string configuration** back to **Build dashboard model + PV config**.
7. Deploy and refresh the dashboard.

The configuration is stored in flow context key `alphaPvStringConfig`, using the `file` context store when available and falling back to the default store.

## Dashboard configuration

Use **Configuration** in the widget to set:

- name of string 1 and string 2
- panel count per string
- panel Wp
- minimum combined PV power required for evaluation
- warning and critical deviation thresholds
- smoothing sample count

The widget reads the first two entries of `payload.data.details.inverter.pv`.

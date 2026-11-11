"""External validation of an observed dataset against official statistics (Phase 7).

common.py   record format, airport-code normalisation, metrics, input registry
bts.py      US DOT BTS T-100 Segment (All Carriers)
anac.py     Brazil ANAC VRA (Voo Regular Ativo)
japan.py    Japan MLIT air transport statistics (flash), national totals only
compare.py  route / airport / tier comparisons on the common format
report.py   runner: writes the validation outputs with metadata
"""

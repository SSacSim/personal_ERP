from datetime import date
from functools import lru_cache

from holidays import country_holidays


@lru_cache(maxsize=32)
def _korean_holidays(year: int) -> tuple[tuple[date, str], ...]:
    return tuple(sorted(country_holidays("KR", years=year, language="ko", observed=True).items()))


def holidays_in_range(start: date, end: date) -> dict[str, str]:
    """Return Korean public holidays, including lunar and substitute holidays."""
    return {
        day.isoformat(): name
        for year in range(start.year, end.year + 1)
        for day, name in _korean_holidays(year)
        if start <= day <= end
    }

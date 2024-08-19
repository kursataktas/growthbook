from abc import abstractmethod
from dataclasses import asdict
from typing import List, Optional

import numpy as np
from pydantic.dataclasses import dataclass
from scipy.stats import t

from gbstats.messages import (
    BASELINE_VARIATION_ZERO_MESSAGE,
    ZERO_NEGATIVE_VARIANCE_MESSAGE,
    ZERO_SCALED_VARIATION_MESSAGE,
)
from gbstats.models.statistics import TestStatistic
from gbstats.models.tests import BaseABTest, BaseConfig, TestResult, Uplift
from gbstats.utils import variance_of_ratios


# Configs
@dataclass
class FrequentistConfig(BaseConfig):
    alpha: float = 0.05
    test_value: float = 0


@dataclass
class SequentialConfig(FrequentistConfig):
    sequential_tuning_parameter: float = 5000


# Results
@dataclass
class FrequentistTestResult(TestResult):
    p_value: float
    error_message: Optional[str] = None


def frequentist_diff(mean_a, mean_b, relative, mean_a_unadjusted=None) -> float:
    if not mean_a_unadjusted:
        mean_a_unadjusted = mean_a
    if relative:
        return (mean_b - mean_a) / mean_a_unadjusted
    else:
        return mean_b - mean_a


def frequentist_variance(var_a, mean_a, n_a, var_b, mean_b, n_b, relative) -> float:
    if relative:
        return variance_of_ratios(mean_b, var_b / n_b, mean_a, var_a / n_a, 0)
    else:
        return var_b / n_b + var_a / n_a


class TTest(BaseABTest):
    def __init__(
        self,
        stat_a: TestStatistic,
        stat_b: TestStatistic,
        config: FrequentistConfig = FrequentistConfig(),
    ):
        """Base class for one- and two-sided T-Tests with unequal variance.
        All values are with respect to relative effects, not absolute effects.
        A result prepared for integration with the stats runner can be
        generated by calling `.compute_result()`

        Args:
            stat_a (Statistic): the "control" or "baseline" statistic
            stat_b (Statistic): the "treatment" or "variation" statistic
        """
        super().__init__(stat_a, stat_b)
        self.alpha = config.alpha
        self.test_value = config.test_value
        self.relative = config.difference_type == "relative"
        self.scaled = config.difference_type == "scaled"
        self.traffic_proportion_b = config.traffic_proportion_b
        self.phase_length_days = config.phase_length_days

    @property
    def variance(self) -> float:
        return frequentist_variance(
            self.stat_a.variance,
            self.stat_a.unadjusted_mean,
            self.stat_a.n,
            self.stat_b.variance,
            self.stat_b.unadjusted_mean,
            self.stat_b.n,
            self.relative,
        )

    @property
    def point_estimate(self) -> float:
        return frequentist_diff(
            self.stat_a.mean,
            self.stat_b.mean,
            self.relative,
            self.stat_a.unadjusted_mean,
        )

    @property
    def critical_value(self) -> float:
        return (self.point_estimate - self.test_value) / np.sqrt(self.variance)

    @property
    def dof(self) -> float:
        # welch-satterthwaite approx
        return pow(
            self.stat_b.variance / self.stat_b.n + self.stat_a.variance / self.stat_a.n,
            2,
        ) / (
            pow(self.stat_b.variance, 2) / (pow(self.stat_b.n, 2) * (self.stat_b.n - 1))
            + pow(self.stat_a.variance, 2)
            / (pow(self.stat_a.n, 2) * (self.stat_a.n - 1))
        )

    @property
    @abstractmethod
    def p_value(self) -> float:
        pass

    @property
    @abstractmethod
    def confidence_interval(self) -> List[float]:
        pass

    def _default_output(
        self, error_message: Optional[str] = None
    ) -> FrequentistTestResult:
        """Return uninformative output when AB test analysis can't be performed
        adequately
        """
        return FrequentistTestResult(
            expected=0,
            ci=[0, 0],
            p_value=1,
            uplift=Uplift(
                dist="normal",
                mean=0,
                stddev=0,
            ),
            error_message=error_message,
        )

    def compute_result(self) -> FrequentistTestResult:
        """Compute the test statistics and return them
        for the main gbstats runner

        Returns:
            FrequentistTestResult -
                note the values are with respect to percent uplift,
                not absolute differences
        """
        if self.stat_a.mean == 0:
            return self._default_output(BASELINE_VARIATION_ZERO_MESSAGE)
        if self.stat_a.unadjusted_mean == 0:
            return self._default_output(BASELINE_VARIATION_ZERO_MESSAGE)
        if self._has_zero_variance():
            return self._default_output(ZERO_NEGATIVE_VARIANCE_MESSAGE)

        result = FrequentistTestResult(
            expected=self.point_estimate,
            ci=self.confidence_interval,
            p_value=self.p_value,
            uplift=Uplift(
                dist="normal",
                mean=self.point_estimate,
                stddev=np.sqrt(self.variance),
            ),
        )
        if self.scaled:
            result = self.scale_result(
                result, self.traffic_proportion_b, self.phase_length_days
            )
        return result

    def scale_result(
        self, result: FrequentistTestResult, p: float, d: float
    ) -> FrequentistTestResult:
        if p == 0:
            return self._default_output(ZERO_SCALED_VARIATION_MESSAGE)
        adjustment = self.stat_b.n / p / d
        return FrequentistTestResult(
            expected=result.expected * adjustment,
            ci=[result.ci[0] * adjustment, result.ci[1] * adjustment],
            p_value=result.p_value,
            uplift=Uplift(
                dist=result.uplift.dist,
                mean=result.uplift.mean * adjustment,
                stddev=result.uplift.stddev * adjustment,
            ),
        )


class TwoSidedTTest(TTest):
    @property
    def p_value(self) -> float:
        return 2 * (1 - t.cdf(abs(self.critical_value), self.dof))  # type: ignore

    @property
    def confidence_interval(self) -> List[float]:
        width: float = t.ppf(1 - self.alpha / 2, self.dof) * np.sqrt(self.variance)
        return [self.point_estimate - width, self.point_estimate + width]


class OneSidedTreatmentGreaterTTest(TTest):
    @property
    def p_value(self) -> float:
        return 1 - t.cdf(self.critical_value, self.dof)  # type: ignore

    @property
    def confidence_interval(self) -> List[float]:
        width: float = t.ppf(1 - self.alpha, self.dof) * np.sqrt(self.variance)
        return [self.point_estimate - width, np.inf]


class OneSidedTreatmentLesserTTest(TTest):
    @property
    def p_value(self) -> float:
        return t.cdf(self.critical_value, self.dof)  # type: ignore

    @property
    def confidence_interval(self) -> List[float]:
        width: float = t.ppf(1 - self.alpha, self.dof) * np.sqrt(self.variance)
        return [-np.inf, self.point_estimate - width]


class SequentialTwoSidedTTest(TTest):
    def __init__(
        self,
        stat_a: TestStatistic,
        stat_b: TestStatistic,
        config: SequentialConfig = SequentialConfig(),
    ):
        config_dict = asdict(config)
        self.sequential_tuning_parameter = config_dict.pop(
            "sequential_tuning_parameter"
        )
        super().__init__(stat_a, stat_b, FrequentistConfig(**config_dict))

    @property
    def confidence_interval(self) -> List[float]:
        # eq 9 in Waudby-Smith et al. 2023 https://arxiv.org/pdf/2103.06476v7.pdf
        N = self.stat_a.n + self.stat_b.n
        rho = self.rho
        s2 = self.variance * N

        width: float = np.sqrt(s2) * np.sqrt(
            (
                (2 * (N * np.power(rho, 2) + 1))
                * np.log(np.sqrt(N * np.power(rho, 2) + 1) / self.alpha)
                / (np.power(N * rho, 2))
            )
        )
        return [self.point_estimate - width, self.point_estimate + width]

    @property
    def rho(self) -> float:
        # eq 161 in https://arxiv.org/pdf/2103.06476v7.pdf
        return np.sqrt(
            (-2 * np.log(self.alpha) + np.log(-2 * np.log(self.alpha) + 1))
            / self.sequential_tuning_parameter
        )

    @property
    def p_value(self) -> float:
        # eq 155 in https://arxiv.org/pdf/2103.06476v7.pdf
        N = self.stat_a.n + self.stat_b.n
        # slight reparameterization for this quantity below
        st2 = np.power(self.point_estimate - self.test_value, 2) * N / (self.variance)
        tr2p1 = N * np.power(self.rho, 2) + 1
        evalue = np.exp(np.power(self.rho, 2) * st2 / (2 * tr2p1)) / np.sqrt(tr2p1)
        return min(1 / evalue, 1)

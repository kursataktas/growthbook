import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RxDesktop } from "react-icons/rx";
import { useRouter } from "next/router";
import { useGrowthBook } from "@growthbook/growthbook-react";
import { datetime, ago } from "shared/dates";
import Link from "next/link";
import { BsFlag } from "react-icons/bs";
import { getDemoDatasourceProjectIdForOrganization } from "shared/demo-datasource";
import LoadingOverlay from "@/components/LoadingOverlay";
import { phaseSummary } from "@/services/utils";
import ResultsIndicator from "@/components/Experiment/ResultsIndicator";
import { useAddComputedFields, useSearch } from "@/services/search";
import WatchButton from "@/components/WatchButton";
import { useDefinitions } from "@/services/DefinitionsContext";
import Pagination from "@/components/Pagination";
import { GBAddCircle } from "@/components/Icons";
import { useUser } from "@/services/UserContext";
import ExperimentsGetStarted from "@/components/HomePage/ExperimentsGetStarted";
import SortedTags from "@/components/Tags/SortedTags";
import Field from "@/components/Forms/Field";
import TabButtons from "@/components/Tabs/TabButtons";
import TabButton from "@/components/Tabs/TabButton";
import { useAnchor } from "@/components/Tabs/ControlledTabs";
import Toggle from "@/components/Forms/Toggle";
import AddExperimentModal from "@/components/Experiment/AddExperimentModal";
import ImportExperimentModal from "@/components/Experiment/ImportExperimentModal";
import { AppFeatures } from "@/types/app-features";
import { useExperiments } from "@/hooks/useExperiments";
import Tooltip from "@/components/Tooltip/Tooltip";
import { useAuth } from "@/services/auth";
import { useWatching } from "@/services/WatchProvider";

const NUM_PER_PAGE = 20;

const ExperimentsPage = (): React.ReactElement => {
  const growthbook = useGrowthBook<AppFeatures>();

  const { ready, project, getMetricById, getProjectById } = useDefinitions();

  const { orgId } = useAuth();

  const { experiments: allExperiments, error, loading } = useExperiments(
    project
  );

  const [tab, setTab] = useAnchor(["running", "drafts", "stopped", "archived"]);

  const [showMineOnly, setShowMineOnly] = useState(false);
  const [showWatchedOnly, setShowWatchedOnly] = useState(false);

  const { watchedExperiments } = useWatching();
  console.log(watchedExperiments);
  const router = useRouter();
  const [openNewExperimentModal, setOpenNewExperimentModal] = useState(false);

  const { getUserDisplay, permissions, userId } = useUser();

  const [currentPage, setCurrentPage] = useState(1);

  const experiments = useAddComputedFields(
    allExperiments,
    (exp) => {
      const projectId = exp.project;
      const projectName = projectId ? getProjectById(projectId)?.name : "";
      const projectIsDeReferenced = projectId && !projectName;

      return {
        ownerName: getUserDisplay(exp.owner, false) || "",
        metricNames: exp.metrics
          .map((m) => getMetricById(m)?.name)
          .filter(Boolean),
        projectId,
        projectName,
        projectIsDeReferenced,
        tab: exp.archived
          ? "archived"
          : exp.status === "draft"
          ? "drafts"
          : exp.status,
        date:
          (exp.status === "running"
            ? exp.phases?.[exp.phases?.length - 1]?.dateStarted
            : exp.status === "stopped"
            ? exp.phases?.[exp.phases?.length - 1]?.dateEnded
            : exp.dateCreated) ?? "",
      };
    },
    [getMetricById, getProjectById]
  );

  const demoExperimentId = useMemo(() => {
    const projectId = getDemoDatasourceProjectIdForOrganization(orgId || "");
    return experiments.find((e) => e.project === projectId)?.id || "";
  }, [orgId, experiments]);

  const filterResults = useCallback(
    (items: typeof experiments) => {
      if (showMineOnly) {
        items = items.filter((item) => item.owner === userId);
      }
      if (showWatchedOnly) {
        items = items.filter((item) => watchedExperiments.includes(item.id));
      }
      return items;
    },
    [showMineOnly, showWatchedOnly, userId]
  );

  const { items, searchInputProps, isFiltered, SortableTH } = useSearch({
    items: experiments,
    localStorageKey: "experiments",
    defaultSortField: "date",
    defaultSortDir: -1,
    searchFields: [
      "name^3",
      "trackingKey^3",
      "id^3",
      "hypothesis^2",
      "description",
      "tags",
      "status",
      "ownerName",
      "metricNames",
      "results",
      "analysis",
    ],
    filterResults,
  });

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    items.forEach((item) => {
      counts[item.tab] = counts[item.tab] || 0;
      counts[item.tab]++;
    });
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((item) => item.tab === tab);
  }, [items, tab]);

  const [showSetup, setShowSetup] = useState(false);

  // If "All Projects" is selected is selected and some experiments are in a project, show the project column
  const showProjectColumn = !project && items.some((e) => e.project);

  // Reset to page 1 when a filter is applied or tabs change
  useEffect(() => {
    setCurrentPage(1);
  }, [items.length, tab, showMineOnly, showWatchedOnly]);

  // Show steps if coming from get started page
  useEffect(() => {
    if (router.asPath.match(/getstarted/)) {
      setShowSetup(true);
    }
  }, [router]);

  if (error) {
    return (
      <div className="alert alert-danger">
        An error occurred: {error.message}
      </div>
    );
  }
  if (loading || !ready) {
    return <LoadingOverlay />;
  }

  const hasExperiments = experiments.some(
    (e) => !e.id.match(/^exp_sample/) && e.id !== demoExperimentId
  );

  if (!hasExperiments) {
    return (
      <div className="contents container pagecontents getstarted">
        <ExperimentsGetStarted />
      </div>
    );
  }

  const canAdd = permissions.check("createAnalyses", project);

  const hasArchivedExperiments = items.some((item) => item.archived);

  const start = (currentPage - 1) * NUM_PER_PAGE;
  const end = start + NUM_PER_PAGE;

  return (
    <>
      <div className="contents experiments container-fluid pagecontents">
        <div className="mb-3">
          <div className="filters md-form row mb-3 align-items-center">
            <div className="col-auto">
              <h1>Experiments</h1>
            </div>
            <div style={{ flex: 1 }} />
            {canAdd && (
              <div className="col-auto">
                <button
                  className="btn btn-primary float-right"
                  onClick={() => {
                    setOpenNewExperimentModal(true);
                  }}
                >
                  <span className="h4 pr-2 m-0 d-inline-block align-top">
                    <GBAddCircle />
                  </span>
                  Add Experiment
                </button>
              </div>
            )}
          </div>
          <div className="mb-3">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setShowSetup(!showSetup);
              }}
            >
              {showSetup ? "Hide" : "Show"} Setup Steps
            </a>
            {showSetup && (
              <div className="appbox p-3 px-4 mb-5">
                <ExperimentsGetStarted />
              </div>
            )}
            {showSetup && <h3>All Experiments</h3>}
          </div>
          <div className="row align-items-center mb-3">
            <div className="col-auto">
              <TabButtons newStyle={true} className="mb-0">
                <TabButton
                  display="Running"
                  anchor="running"
                  count={tabCounts["running"] || 0}
                  active={tab === "running"}
                  onClick={() => setTab("running")}
                />
                <TabButton
                  display="Drafts"
                  anchor="drafts"
                  count={tabCounts["drafts"] || 0}
                  active={tab === "drafts"}
                  onClick={() => setTab("drafts")}
                />
                <TabButton
                  display="Stopped"
                  anchor="stopped"
                  count={tabCounts["stopped"] || 0}
                  active={tab === "stopped"}
                  onClick={() => setTab("stopped")}
                  last={!hasArchivedExperiments}
                />
                {hasArchivedExperiments && (
                  <TabButton
                    display="Archived"
                    anchor="archived"
                    count={tabCounts["archived"] || 0}
                    active={tab === "archived"}
                    onClick={() => setTab("archived")}
                    last={true}
                  />
                )}
              </TabButtons>
            </div>
            <div className="col-auto">
              <Field
                placeholder="Search..."
                type="search"
                {...searchInputProps}
              />
            </div>
            <div className="col-auto ml-auto">
              <Toggle
                id="watched-experiments-toggle"
                type="toggle"
                value={showWatchedOnly}
                setValue={(value) => {
                  setShowWatchedOnly(value);
                }}
              />{" "}
              Watched Experiments Only
            </div>
            <div className="col-auto ml-auto">
              <Toggle
                id="my-experiments-toggle"
                type="toggle"
                value={showMineOnly}
                setValue={(value) => {
                  setShowMineOnly(value);
                }}
              />{" "}
              My Experiments Only
            </div>
          </div>

          <table className="appbox table experiment-table gbtable responsive-table">
            <thead>
              <tr>
                <th></th>
                <SortableTH field="name" className="w-100">
                  Experiment
                </SortableTH>
                {showProjectColumn && (
                  <SortableTH field="projectName">Project</SortableTH>
                )}
                <SortableTH field="tags">Tags</SortableTH>
                <SortableTH field="ownerName">Owner</SortableTH>
                {tab === "running" && <th>Phase</th>}
                <SortableTH field="date">
                  {tab === "running"
                    ? "Started"
                    : tab === "stopped"
                    ? "Ended"
                    : tab === "drafts"
                    ? "Created"
                    : "Date"}
                </SortableTH>
                {tab === "stopped" && (
                  <SortableTH field="results">Result</SortableTH>
                )}
                {tab === "archived" && (
                  <SortableTH field="status">State</SortableTH>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(start, end).map((e) => {
                const phase = e.phases?.[e.phases.length - 1];
                return (
                  <tr key={e.id} className="hover-highlight">
                    <td data-title="Watching status:" className="watching">
                      <WatchButton
                        item={e.id}
                        itemType="experiment"
                        type="icon"
                      />
                    </td>
                    <td
                      onClick={() => {
                        router.push(`/experiment/${e.id}`);
                      }}
                      className="cursor-pointer"
                      data-title="Experiment name:"
                    >
                      <div className="d-flex flex-column">
                        <div className="d-flex">
                          <Link href={`/experiment/${e.id}`}>
                            <a className="testname">{e.name}</a>
                          </Link>
                          {e.hasVisualChangesets ? (
                            <Tooltip
                              className="d-flex align-items-center ml-2"
                              body="Visual experiment"
                            >
                              <RxDesktop className="text-blue" />
                            </Tooltip>
                          ) : null}
                          {(e.linkedFeatures || []).length > 0 ? (
                            <Tooltip
                              className="d-flex align-items-center ml-2"
                              body="Linked Feature Flag"
                            >
                              <BsFlag className="text-blue" />
                            </Tooltip>
                          ) : null}
                        </div>
                        {isFiltered && e.trackingKey && (
                          <span
                            className="testid text-muted small"
                            title="Experiment Id"
                          >
                            {e.trackingKey}
                          </span>
                        )}
                      </div>
                    </td>
                    {showProjectColumn && (
                      <td className="nowrap" data-title="Project:">
                        {e.projectIsDeReferenced ? (
                          <Tooltip
                            body={
                              <>
                                Project <code>{e.project}</code> not found
                              </>
                            }
                          >
                            <span className="text-danger">Invalid project</span>
                          </Tooltip>
                        ) : (
                          e.projectName ?? <em>All Projects</em>
                        )}
                      </td>
                    )}
                    <td className="nowrap" data-title="Tags:">
                      <SortedTags tags={Object.values(e.tags)} />
                    </td>
                    <td className="nowrap" data-title="Owner:">
                      {e.ownerName}
                    </td>
                    {tab === "running" && (
                      <td className="nowrap" data-title="Phase:">
                        {phase && phaseSummary(phase)}
                      </td>
                    )}
                    <td className="nowrap" title={datetime(e.date)}>
                      {ago(e.date)}
                    </td>
                    {tab === "stopped" && (
                      <td className="nowrap" data-title="Results:">
                        {e.results && <ResultsIndicator results={e.results} />}
                      </td>
                    )}
                    {tab === "archived" && (
                      <td className="nowrap">{e.status}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > NUM_PER_PAGE && (
            <Pagination
              numItemsTotal={filtered.length}
              currentPage={currentPage}
              perPage={NUM_PER_PAGE}
              onPageChange={setCurrentPage}
            />
          )}
        </div>
      </div>
      {openNewExperimentModal &&
        (growthbook?.isOn("new-experiment-modal") ? (
          <AddExperimentModal
            onClose={() => setOpenNewExperimentModal(false)}
            source="experiment-list"
          />
        ) : (
          <ImportExperimentModal
            onClose={() => setOpenNewExperimentModal(false)}
            source="experiment-list"
          />
        ))}
    </>
  );
};

export default ExperimentsPage;

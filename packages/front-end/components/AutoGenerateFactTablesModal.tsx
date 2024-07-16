import { useState, useEffect, useCallback, Fragment } from "react";
import {
  AutoFactTableToCreate,
  InformationSchemaInterface,
} from "@back-end/src/types/Integration";
import { DataSourceInterfaceWithParams } from "@back-end/types/datasource";
import { cloneDeep } from "lodash";
import { useForm } from "react-hook-form";
import { FaExternalLinkAlt, FaRedo } from "react-icons/fa";
import track from "@/services/track";
import { useAuth } from "@/services/auth";
import { useDefinitions } from "@/services/DefinitionsContext";
import { DocLink } from "./DocLink";
import Modal from "./Modal";
import Tooltip from "./Tooltip/Tooltip";
import SelectField from "./Forms/SelectField";
import LoadingOverlay from "./LoadingOverlay";
import LoadingSpinner from "./LoadingSpinner";
import Button from "./Button";
import SQLInputField from "./SQLInputField";

type Props = {
  setShowAutoGenerateFactTableModal: (show: boolean) => void;
  datasource?: DataSourceInterfaceWithParams;
  source: string;
  mutate: () => void;
  supportedDatasources: DataSourceInterfaceWithParams[];
};

export default function AutoGenerateFactTableModal({
  setShowAutoGenerateFactTableModal,
  datasource,
  source,
  mutate,
  supportedDatasources,
}: Props) {
  const [autoFactTableError, setAutoFactTableError] = useState("");
  const { apiCall } = useAuth();
  const [loading, setLoading] = useState(false);
  const { getDatasourceById } = useDefinitions();
  const [availableSchemas, setAvailableSchemas] = useState<string[]>([]);
  const [refreshingSchema, setRefreshingSchema] = useState(false);
  const [retryCount, setRetryCount] = useState(1);
  const [refreshingSchemaError, setRefreshingSchemaError] = useState("");
  const [selectedDatasourceData, setSelectedDatasourceData] = useState<{
    informationSchema: InformationSchemaInterface | undefined;
  }>({
    informationSchema: undefined,
  });
  const [checkAll, setCheckAll] = useState(true);

  interface AutoFactTableToCreateForm extends AutoFactTableToCreate {
    showSqlPreview: boolean;
  }

  const form = useForm<{
    datasourceId: string;
    schema: string;
    factTablesToCreate: AutoFactTableToCreateForm[];
  }>({
    defaultValues: {
      datasourceId: datasource?.id || "",
      schema: "",
      factTablesToCreate: [],
    },
  });

  const selectedSchema = form.watch("schema");
  const factTablesToCreate = form.watch("factTablesToCreate");

  const selectedDatasource =
    datasource || getDatasourceById(form.watch("datasourceId"));

  const schemaName =
    selectedDatasource?.type === "bigquery"
      ? "Dataset"
      : selectedDatasource?.type === "athena"
      ? "Catalog"
      : "Schema";

  const submit = form.handleSubmit(async (data) => {
    setAutoFactTableError("");
    track("Generating Auto Fact Table For User", {
      factTablesCreated: data.factTablesToCreate,
      source,
      type: selectedDatasource?.type,
      dataSourceId: selectedDatasource?.id,
      schema: selectedDatasource?.settings.schemaFormat,
    });

    if (!selectedDatasource?.id) {
      setAutoFactTableError("Must select a data source before submitting");
      return;
    }

    try {
      await apiCall(`/datasource/${selectedDatasource.id}/auto-tables`, {
        method: "POST",
        body: JSON.stringify({
          datasourceId: selectedDatasource.id,
          factTables: data.factTablesToCreate
            .filter((table) => table.shouldCreate === true)
            .map((table) => {
              return {
                name: table.eventName,
                sql: table.sql,
                userIdTypes: table.userIdTypes,
              };
            }),
        }),
      });
      mutate();
    } catch (e) {
      setAutoFactTableError(e.message);
    }
  });

  const getTrackedEvents = useCallback(
    async (datasourceObj: DataSourceInterfaceWithParams | undefined) => {
      setAutoFactTableError("");
      form.setValue("factTablesToCreate", []);
      if (
        !datasourceObj ||
        !datasourceObj?.properties?.supportsAutoGeneratedFactTables
      ) {
        return;
      }

      if (
        datasourceObj.settings.schemaFormat === "amplitude" &&
        !datasourceObj.settings?.schemaOptions?.projectId
      ) {
        setAutoFactTableError(
          "Missing Amplitude Project Id - Click the 'Edit Connection Info' button at the top of this page to add your project id."
        );
        return;
      }
      try {
        setLoading(true);
        track("Generate Auto Fact Tables CTA Clicked", {
          source,
          type: datasourceObj.type,
          dataSourceId: datasourceObj.id,
          schema: datasourceObj?.settings.schemaFormat,
          newDatasourceForm: true,
        });
        const res = await apiCall<{
          autoFactTablesToCreate: AutoFactTableToCreate[];
          message?: string;
        }>(`/datasource/${datasourceObj.id}/tracked-events`, {
          method: "POST",
          body: JSON.stringify({ schema: selectedSchema }),
        });
        setLoading(false);
        if (res.message) {
          track("Generate Auto Fact Tables Error", {
            error: res.message,
            source,
            type: datasourceObj.type,
            dataSourceId: datasourceObj.id,
            schema: datasourceObj.settings.schemaFormat,
          });
          setAutoFactTableError(res.message);
          return;
        }

        if (res.autoFactTablesToCreate.length) {
          form.setValue(
            "factTablesToCreate",
            res.autoFactTablesToCreate.map((table) => ({
              ...table,
              showSqlPreview: false,
            }))
          );
        }
      } catch (e) {
        track("Generate Auto Fact Tables Error", {
          error: e.message,
          source,
          type: datasourceObj.type,
          dataSourceId: datasourceObj.id,
          schema: datasourceObj.settings.schemaFormat,
        });
        setAutoFactTableError(e.message);
      }
    },
    [apiCall, form, selectedSchema, source]
  );

  useEffect(() => {
    if (!selectedDatasource) return;

    if (!selectedSchema && availableSchemas.length === 1) {
      form.setValue("schema", availableSchemas[0]);
    }

    if (!selectedSchema) return;

    getTrackedEvents(selectedDatasource);
  }, [
    availableSchemas,
    form,
    getTrackedEvents,
    selectedDatasource,
    selectedSchema,
  ]);

  useEffect(() => {
    if (selectedDatasourceData?.informationSchema) {
      const schemas: string[] = [];
      selectedDatasourceData.informationSchema.databases.forEach((database) => {
        database.schemas.forEach((schema) => {
          schemas.push(schema.schemaName);
        });
      });
      setAvailableSchemas(schemas);
    }
  }, [selectedDatasourceData?.informationSchema]);

  useEffect(() => {
    if (refreshingSchema) {
      if (
        retryCount > 1 &&
        retryCount < 8 &&
        selectedDatasourceData?.informationSchema?.status === "COMPLETE"
      ) {
        setRefreshingSchema(false);
        setRetryCount(1);
      } else if (retryCount > 8) {
        setRefreshingSchema(false);
        setRefreshingSchemaError(
          "This query is taking quite a while. We're building this in the background. Feel free to leave this page and check back in a few minutes."
        );
        setRetryCount(1);
      } else {
        const timer = setTimeout(() => {
          mutate();
          setRetryCount(retryCount * 2);
        }, retryCount * 1000);
        return () => {
          clearTimeout(timer);
        };
      }
    }
  }, [
    refreshingSchema,
    mutate,
    retryCount,
    selectedDatasourceData?.informationSchema?.status,
  ]);

  useEffect(() => {
    async function getInformationSchema(dataSourceId: string) {
      try {
        const { informationSchema } = await apiCall<{
          status: number;
          informationSchema?: InformationSchemaInterface;
        }>(`/datasource/${dataSourceId}/schema`, {});
        if (informationSchema?.error?.message) {
          setAutoFactTableError(informationSchema.error.message);
        }
        setSelectedDatasourceData({ informationSchema });
      } catch (e) {
        setAutoFactTableError(e.message);
      }
    }

    if (selectedDatasource?.id) {
      getInformationSchema(selectedDatasource.id);
    }
  }, [apiCall, selectedDatasource?.id]);

  return (
    <Modal
      size="lg"
      open={true}
      header="Discover Fact Tables"
      close={() => setShowAutoGenerateFactTableModal(false)}
      submit={submit}
      cta={`Generate Fact Table${
        factTablesToCreate.filter((factTable) => factTable.shouldCreate)
          .length > 1
          ? "s"
          : ""
      }`}
      ctaEnabled={
        factTablesToCreate.length > 0 &&
        factTablesToCreate.some((factTable) => factTable.shouldCreate)
      }
    >
      <>
        <p>
          Generate Fact Tables automatically by selecting from the following
          data sources: Google Analytics V4, Segment, Amplitude, or Rudderstack.
          <DocLink className="pl-1" docSection={"factTables"}>
            Learn More <FaExternalLinkAlt size={12} />
          </DocLink>
        </p>
        <SelectField
          label="Select A Supported Data Source"
          value={selectedDatasource?.id || ""}
          onChange={(datasourceId) => {
            form.setValue("schema", "");
            form.setValue("datasourceId", datasourceId);
            setAvailableSchemas([]);
          }}
          options={(supportedDatasources || []).map((d) => ({
            value: d.id,
            label: `${d.name}${d.description ? ` — ${d.description}` : ""}`,
          }))}
          className="portal-overflow-ellipsis"
          name="datasource"
          disabled={datasource ? true : false}
        />
        {availableSchemas.length > 1 ? (
          <SelectField
            disabled={
              !selectedDatasource?.properties?.supportsAutoGeneratedFactTables
            }
            label={
              <div className="d-flex align-items-center pt-2">
                Select a {schemaName}
                {selectedDatasource?.id ? (
                  <Tooltip
                    body={`Refresh list of ${schemaName.toLocaleLowerCase()}s`}
                    tipPosition="top"
                  >
                    <button
                      className="btn btn-link p-0 pl-1 text-secondary"
                      disabled={refreshingSchema}
                      onClick={async (e) => {
                        e.preventDefault();
                        setRefreshingSchemaError("");
                        try {
                          await apiCall<{
                            status: number;
                            message?: string;
                          }>(`/datasource/${selectedDatasource.id}/schema`, {
                            method: "PUT",
                            body: JSON.stringify({
                              informationSchemaId:
                                selectedDatasource.settings.informationSchemaId,
                            }),
                          });
                          setRefreshingSchema(true);
                        } catch (e) {
                          setRefreshingSchemaError(e.message);
                        }
                      }}
                    >
                      {refreshingSchema ? <LoadingSpinner /> : <FaRedo />}
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            }
            value={form.watch("schema") || ""}
            onChange={(schema) => {
              form.setValue("schema", schema);
            }}
            options={availableSchemas.map((schema) => ({
              value: schema,
              label: schema,
            }))}
          />
        ) : null}
        {loading ? <LoadingOverlay /> : null}
        {factTablesToCreate.length > 0 ? (
          <div className="pt-2">
            <label className="font-weight-bold">
              Select Fact Tables to Auto-generate
            </label>
            <p>
              The following tracked events have been detected and can be used to
              automatically generate Fact Tables. Selected Fact Tables will be
              editable after they&apos;re generated.
              <DocLink className="ml-1" docSection={"factTables"}>
                Learn More <FaExternalLinkAlt size={12} />
              </DocLink>
            </p>
            <table className="table gbtable" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr>
                  <th className="col-1">
                    <input
                      type="checkbox"
                      checked={checkAll}
                      onChange={async (e) => {
                        const updates = cloneDeep(factTablesToCreate);
                        setCheckAll(e.target.checked);
                        updates.forEach((table) => {
                          if (!e.target.checked) {
                            if (table.shouldCreate && !table.alreadyExists) {
                              table.shouldCreate = false;
                            }
                          } else {
                            if (!table.shouldCreate && !table.alreadyExists) {
                              table.shouldCreate = true;
                            }
                          }
                        });
                        form.setValue("factTablesToCreate", updates);
                      }}
                    />
                  </th>
                  <th className="col-auto">
                    <Tooltip body="By default, the table is named after the tracked event. You can change this after.">
                      Fact Table Name
                    </Tooltip>
                  </th>
                  <th className="col-2">
                    <Tooltip body="This is the SQL that will be used to define the Fact Table. It can be edited after the Fact Table is created.">
                      SQL
                    </Tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {factTablesToCreate.map((table, i) => {
                  return (
                    <Fragment key={`${table}-${i}`}>
                      <tr>
                        <td>
                          <Tooltip
                            body="This event has already been used to create a Fact Table"
                            shouldDisplay={table.alreadyExists}
                          >
                            <div className="d-flex align-items-center">
                              <input
                                type="checkbox"
                                id={table.eventName}
                                disabled={table.alreadyExists}
                                checked={table.shouldCreate}
                                className="ml-0 pl-0 mr-2 "
                                onChange={async (e) => {
                                  // Here, I need to call a named function?
                                  const updatedFactTablesToCreate = cloneDeep(
                                    factTablesToCreate
                                  );
                                  updatedFactTablesToCreate[i].shouldCreate =
                                    e.target.checked;
                                  form.setValue(
                                    "factTablesToCreate",
                                    updatedFactTablesToCreate
                                  );

                                  // The logic below will up the header row checkbox
                                  const eligibleFactTables = updatedFactTablesToCreate.filter(
                                    (ft) => ft.alreadyExists === false
                                  );

                                  // If checkAll is checked, but every row is unchecked, set checkAll to false
                                  if (
                                    checkAll &&
                                    eligibleFactTables.every(
                                      (ft) => ft.shouldCreate === false
                                    )
                                  ) {
                                    setCheckAll(false);
                                  }

                                  // if checkAll is unchecked, but every row is checked, set checkAll to true
                                  if (
                                    !checkAll &&
                                    eligibleFactTables.every(
                                      (ft) => ft.shouldCreate
                                    )
                                  ) {
                                    setCheckAll(true);
                                  }
                                }}
                              />
                            </div>
                          </Tooltip>
                        </td>
                        <td>
                          <span
                            className={table.alreadyExists ? "text-muted" : ""}
                          >
                            {table.displayName}
                          </span>
                        </td>
                        <td>
                          <Button
                            color="link"
                            className="p-0"
                            onClick={async () => {
                              const updatedFactTablesToCreate = cloneDeep(
                                factTablesToCreate
                              );

                              updatedFactTablesToCreate[
                                i
                              ].showSqlPreview = !table.showSqlPreview;
                              form.setValue(
                                "factTablesToCreate",
                                updatedFactTablesToCreate
                              );
                            }}
                          >
                            {table.showSqlPreview ? "Hide SQL" : "Preview SQL"}
                          </Button>
                        </td>
                      </tr>
                      {table.showSqlPreview && (
                        <tr
                          className="bg-light"
                          style={{
                            boxShadow:
                              "rgba(0, 0, 0, 0.06) 0px 2px 4px 0px inset",
                          }}
                        >
                          <td colSpan={3}>
                            <SQLInputField
                              showPreview
                              userEnteredQuery={table.sql}
                              datasourceId={form.watch("datasourceId")}
                              form={form}
                              requiredColumns={new Set()}
                              queryType="factTable"
                              showTestButton={false}
                              showHeadline={false}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {autoFactTableError && (
          <div className="alert alert-danger">
            <p>
              We were unable to identify any Fact Tables to generate for you
              automatically. The query we ran to identify Fact Tables returned
              the following error.
            </p>
            <div>
              <strong>Error: {autoFactTableError}</strong>
            </div>
          </div>
        )}
        {refreshingSchema ? (
          <div className="alert alert-info">
            Refreshing list of {schemaName.toLocaleLowerCase()}s...
          </div>
        ) : null}
        {refreshingSchemaError ? (
          <div className="alert alert-danger">{refreshingSchemaError}</div>
        ) : null}
      </>
    </Modal>
  );
}
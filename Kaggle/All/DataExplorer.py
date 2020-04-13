#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun Apr  5 12:07:26 2020

@author: fraifeld-mba
"""

import pandas as pd
import os
from matplotlib import pyplot as plt
from matplotlib.cm import viridis
from itertools import combinations
from matplotlib.lines import Line2D

class ExploratoryDataAnalyzer:
    
    def __init__(self,df=None,csv_path=None):
        if len(df) > 0:
            self.original_df = df
        elif csv_path:
            self.original_df = pd.read_csv(csv_path)
        else:
            self.original_df = pd.DataFrame()
            
        self.filtered_df = pd.DataFrame()
        
        # This is a pointerto the original df, but it can switch to the filtered df
        self.DataFrame = self.original_df.copy(deep=False)
        
    def set_filtered_data(self,subset):
        """
        Sets the subset to be the filtered dataframe
        """
        self.filtered_df = subset.reset_index(drop=True)
    def pin_filtered_data(self):
        """
        Sets the DataFrame object to be the filtered data
        This allows the operations defined above to occur on the filtered data
        """
        self.DataFrame = self.filtered_df
        
    def pin_original_data(self):
        """
        Sets the DataFrame object to be the original data
        This allows the operations defined above to occur on the original data
        """
        self.DataFrame = self.original_df
    
    def reset_data(self):
        """
        Alias for pin original data
        """
        self.pin_original_data()
             

    
class Describer(ExploratoryDataAnalyzer):
   
    
    """
    Statistically and graphically describe a dataset
    """
    
    """
    Statistically describe a dataset; number of rows/columns, missing data, data types, preview.
    """
    
    def __init__(self,df=None,csv_path=None):
        super().__init__(df,csv_path)

        
    def get_column_names(self):
        return list(self.DataFrame.columns)
    
    def count_columns(self):
        return len(self.DataFrame.columns)
    
    def count_rows(self):
        return len(self.DataFrame)
    
    def get_shape(self):
        return self.DataFrame.shape
    
    def count_missing_data(self,columns=[],validate=True):
        if validate:
            columns = [c for c in columns if c in self.DataFrame.columns] # validation
        if len(columns) == 0:
            return self.DataFrame.isna().sum()
        else:
            return self.DataFrame[columns].isna().sum()
    
    def list_data_types(self):
        return self.DataFrame.dtypes
    
    def list_numeric_columns(self):
        return list(self.DataFrame._get_numeric_data().columns)
    
    def head(self,columns=[],n=10,validate=True):
        if len(columns) == 0: 
            return self.DataFrame.head(n)
        if validate:
            columns = [c for c in columns if c in self.DataFrame.columns] # validation
        return self.DataFrame[columns].head(n)
    
    def view_example_values(self,columns=[],n=10,validate=True):
        h = self.head(columns,n,validate)
        for c in h.columns:
            print(c)
            print("-"*(len(c)+2))
            print("\n".join(map(str,h[c].values)))
            print('\n')
    
    def get_value_count_column(self,c,top_n):
        unique_value_count = len(self.DataFrame['Age'].unique())
        top_n = min(unique_value_count, top_n)
        return self.DataFrame[c].value_counts().reset_index().rename(columns={c:"Count","index":c})[0:top_n]
    
    
    def get_value_counts(self,columns=[],validate=True,top_n = None):
        if validate:
            columns = [c for c in columns if c in self.DataFrame.columns] # validation
        if len(columns) == 0:
            columns = list(self.DataFrame.columns)
        if top_n:
            return {c: self.get_value_count_column(c,top_n) for c in columns if c in self.DataFrame.columns}
        
        else: 
            return {c: self.DataFrame[c].value_counts() for c in columns}
        
    def get_summary_statistics(self,columns=[],validate=True):
        if validate:
            columns = [c for c in columns if c in self.DataFrame.columns] # validation
        if len(columns) == 0:
            return self.DataFrame.describe().transpose()

        return self.DataFrame[columns].describe().transpose()


    """
    Graphically describe a dataset: bar charts, histograms, box plots, visualize correlations
    """
    
    
    def get_colors_from_values(self,data,all_data=True):
        unique_values = set(data)
        num_categories = len(unique_values)
        value_dict = {x:i for i,x in enumerate(unique_values)}
        color_dict = {x:viridis(float(value_dict[x]/num_categories)) for x in unique_values}
        if all_data:
            return {"color_dict":color_dict,
                    "color_list":[color_dict[x] for x in data]}
        else:
            return  color_dict

    
    def get_legend_info(self,data,all_data=True):
        colors = self.get_colors_from_values(data,all_data)
        if all_data:
            legend_handles = [Line2D([0], [0], marker='o', color='w', label=str(k.capitalize()), markerfacecolor=colors['color_dict'][k], markersize=6) for k in colors['color_dict'].keys()]
            return {"handles":legend_handles,"colors":colors['color_list']}
        else:
            legend_handles = [Line2D([0], [0], marker='o', color='w', label=str(k.capitalize()), markerfacecolor=colors[k], markersize=6) for k in colors.keys()]
            return {"handles":legend_handles,"colors":colors}
            
        
       
        
    
    def display_graph(self,graph_type,data,column_name,custom_string="",dropna = True,split_on=None,matrix=False):
        """
        Basic Single Graph Display Function
        Iterated over in the graph display functions below
        """
        allowed_graphs = ['histogram','box','1dbox','2dbox','scatter','line','heatmap']
        graph_type = graph_type.lower()
        
        # validation
        if graph_type not in allowed_graphs:
            raise Exception("InvalidGraphTypeError",graph_type + " is not one of the graphs for which display_graph is implemented")
        
        if dropna:
            data = data.dropna()
            
        if graph_type == "histogram":
       
            plt.hist(data)
            title = column_name
            
        if graph_type == "scatter":
            if not matrix:
                if split_on:
                    legend_info = self.get_legend_info(data['x']['data'][split_on])
                    colors = legend_info['colors']
                    handles = legend_info['handles']
                    plt.scatter(data['x']['data'].loc[:,column_name[0]],data['y']['data'].loc[:,column_name[1]],color = colors)
                    plt.legend(handles=handles)
                    custom_string = custom_string + "\nColors Based On: " + split_on
                else:
                    plt.scatter(data['x']['data'],data['y']['data'])
                
                plt.xlabel(data['x']['label'])
                plt.ylabel(data['y']['label'])
                
                title = data['x']['label'] + " relationship to " + data['y']['label']
           # else:
            #    print("MATRIX MODE HAS NOT BEEN IMPLEMENTED")
        
        if graph_type == "heatmap":
            print("This has not been implemented")
            # Use this : https://towardsdatascience.com/better-heatmaps-and-correlation-matrix-plots-in-python-41445d0f2bec
            
        if graph_type == 'box':
            title = column_name
            if not split_on:
                plt.boxplot(data)
            else:
                x_labels = list(set(self.DataFrame[split_on]))
                data_to_plot = [data[data[split_on] == x][column_name] for x in x_labels]
                plt.boxplot(data_to_plot,labels = x_labels)
        
        plt.title(graph_type.capitalize()+": " + title + "\n"+custom_string)
        plt.show()
    
    def show_histogram(self,columns=[],validate=True,custom_string="",split_on=None):
        """
        Iterate over the columns and show the histogram for each column
        Can add custom string to the title
        No other flexibility. If bins should be different, or anything else needs to change
        Invoke matplotlib function directly on the dataframe
        """
        if validate:
            numeric_columns = self.list_numeric_columns()
            columns = [c for c in columns if c in numeric_columns] # validation
            
        if len(columns) == 0:
            columns = self.list_numeric_columns()
        
        
        if split_on not in self.DataFrame.columns:
            split_on = None
            [self.display_graph("histogram",self.DataFrame[c],c,custom_string) for c in columns]
        else:
             x_labels = list(set(self.DataFrame[split_on]))
             data_to_plot = {x+"_"+c:self.DataFrame[self.DataFrame[split_on] == x][c] for x in x_labels for c in columns}
             
             
             
             [self.display_graph("histogram",data_to_plot[k],k.split("_")[1],split_on + " = " + k.split("_")[0],split_on = split_on) for k in data_to_plot.keys()]
    
   
    def construct_column_pairs(self,columns):
        return list(combinations(columns,2))
    
    def construct_scatter_data_dict(self,pair,split_on=None):
        if split_on:
            return {'x':{'data':self.DataFrame[[pair[0],split_on]],'label':pair[0]},
                'y':{'data':self.DataFrame[[pair[1],split_on]],'label':pair[1]}}
        else:
            return {'x':{'data':self.DataFrame[pair[0]],'label':pair[0]},
                    'y':{'data':self.DataFrame[pair[1]],'label':pair[1]}}

    def get_correlation_coefficient(self,pair):
        return self.DataFrame[pair[0]].corr(self.DataFrame[pair[1]])
    
    def show_scatter_plot(self,columns=[],validate=True,custom_string="",split_on=None):
        
        ## Add the option to show a regression line
        
        if len(columns) == 0:
            columns = self.list_numeric_columns()
        if validate:
            numeric_columns = self.list_numeric_columns()
            columns = [c for c in columns if c in numeric_columns] # validation
            if split_on not in self.DataFrame.columns:
                split_on = None
            
        pairs = self.construct_column_pairs(columns)
        
        [self.display_graph("scatter",
                            self.construct_scatter_data_dict(p,split_on),
                            p,
                            "Correlation: " + str(self.get_correlation_coefficient(p)),
                            split_on) for p in pairs]
    
    
    
    def show_box_plot(self,columns=[],validate=True,custom_string="",split_on = None):
        
        
        ## Need to implement split_on
        
        numerics = self.list_numeric_columns()
        if validate:
            columns = [c for c in columns if c in numerics] # validation
        if len(columns) == 0:
            columns = numerics
        if split_on not in self.DataFrame.columns:
            split_on = None
            [self.display_graph("box",self.DataFrame[c],c,custom_string) for c in columns]
        else:
            [self.display_graph("box",self.DataFrame.loc[:,[c,split_on]],c,custom_string,split_on = split_on) for c in columns]
       

    
    def show_correlation_heatmap(self,columns=[],validate=True,custom_string = ""):
        numerics = self.list_numeric_columns()
        if validate:
            columns = [c for c in columns if c in numerics] # validation
        if len(columns) == 0:
            columns = numerics
        data = self.DataFrame[[columns]].corr()
        self.display_graph("heatmap",data,custom_string)
        
csv = [x for x in os.listdir() if ".csv" in x]
if len(csv) == 0:
   print("NO CSV IN WORKING DIRECTORY") 
else:
    df = pd.read_csv(csv[0])
    tester = Describer(df)